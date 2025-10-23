import 'dotenv/config'; // Loads .env file
import fs from 'fs';
import { parse } from 'csv-parse';

// --- Configuration ---
// The product tag to filter by.
const PRODUCT_TAG = 'regiment_pride';
// The CSV file containing your sales data
const CSV_FILE = 'sales-export.csv';
const LOG_FILE = 'sort-variants.log';
// Delay between API fetches (products) in milliseconds
const API_FETCH_DELAY_MS = 500;
// Delay between each product update (mutations) in milliseconds
const API_MUTATION_DELAY_MS = 1000;
// Shopify API Version
const API_VERSION = '2024-10';
// Name of the option representing Color (case-insensitive check)
const COLOR_OPTION_NAME = 'Color';
// ---------------------

// Setup logging to both console and file
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function logMessage(level, message) {
  const timestamp = new Date().toISOString();
  const log = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  console.log(log); // Log to console
  logStream.write(log + '\n'); // Log to file
}

// Utility to pause execution
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Global variables for Shopify API ---
let shopifyEndpoint = '';
let shopifyHeaders = {};

/**
 * A helper function to make GraphQL calls to Shopify
 */
async function shopifyFetch(query, variables) {
  try {
    const response = await fetch(shopifyEndpoint, {
      method: 'POST',
      headers: shopifyHeaders,
      body: JSON.stringify({
        query: query,
        variables: variables,
      }),
    });

    const data = await response.json();

    // Specific check for productOptionsReorder potentially returning data + errors
     if (data.errors && query !== REORDER_OPTIONS_MUTATION) {
       // Allow productOptionsReorder errors to be handled later if needed
       logMessage('error', `GraphQL Error: ${JSON.stringify(data.errors)}`);
       throw new Error('GraphQL Error');
     }
     // Log errors for productOptionsReorder but don't throw immediately if data exists
     if (data.errors && query === REORDER_OPTIONS_MUTATION) {
         logMessage('warn', `GraphQL Error during productOptionsReorder (will continue if data present): ${JSON.stringify(data.errors)}`);
         if (!data.data?.productOptionsReorder?.product) { // Only throw if no product data returned
             throw new Error('GraphQL Error during productOptionsReorder');
         }
     }


    if (!response.ok) {
        logMessage('error', `API HTTP Error: ${response.status} ${response.statusText}`);
        throw new Error(`API HTTP Error: ${response.status}`);
    }

    // Check for userErrors within the data payload for mutations
    const mutationName = Object.keys(data.data)[0]; // e.g., 'productOptionsReorder', 'productVariantsBulkUpdate'
    if (data.data[mutationName]?.userErrors?.length > 0) {
        logMessage('warn', `UserErrors in ${mutationName}: ${JSON.stringify(data.data[mutationName].userErrors)}`);
        // Decide if you want to throw an error here or just log it
        // For productOptionsReorder, we might want to continue even with some errors if product data exists
        if (mutationName !== 'productOptionsReorder' || !data.data.productOptionsReorder.product) {
           // throw new Error(`UserErrors during ${mutationName}`); // Re-enable if strict error handling is needed
        }
    }


    return data.data;
  } catch (e) {
    logMessage('error', `API Fetch Error: ${e.message}`);
    if (e.message.includes('429') || e.message.includes('Too Many Requests')) {
      logMessage('warn', 'Rate limit likely hit. Waiting 10 seconds...');
      await sleep(10000); // Wait 10s
    }
    throw e; // Re-throw
  }
}

/**
 * Extracts the color from a variant title, assuming format "Color / Size".
 * Returns null if format is unexpected.
 */
function extractColorFromTitle(title) {
    if (title && title.includes(' / ')) {
        return title.split(' / ')[0].trim();
    }
    // Handle cases where title might just be the color
    if (title && !title.includes(' / ')) {
        // More robust check needed? For now, assume it's color if not obviously size/number
        if (!/\d/.test(title) && !/^(xs|s|m|l|xl|xxl|2xl|3xl|4xl|5xl|6xl)$/i.test(title.trim())) {
             return title.trim();
        }
    }
    logMessage('warn', `Could not reliably extract color from variant title: "${title}"`);
    return null;
}


/**
 * Reads the sales data from a local CSV file
 */
function loadSalesTallyFromCSV() {
  return new Promise((resolve, reject) => {
    logMessage('info', `Reading sales data from ${CSV_FILE}...`);

    const variantSalesTally = new Map(); // Title -> Title -> Sales
    const productSalesTally = new Map(); // Title -> Color -> Sales

    if (!fs.existsSync(CSV_FILE)) {
        return reject(new Error(`CSV file not found: ${CSV_FILE}. Please make sure it's in the same folder.`));
    }

    const parser = fs
      .createReadStream(CSV_FILE)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }));

    parser.on('data', (row) => {
      try {
        const productTitle = row['Product title']?.trim();
        const variantTitle = row['Product variant title']?.trim();
        const sales = parseInt(row['Net items sold'], 10);

        if (productTitle && variantTitle && !isNaN(sales)) {
          // Populate Tally 1 (Individual)
          if (!variantSalesTally.has(productTitle)) {
            variantSalesTally.set(productTitle, new Map());
          }
          variantSalesTally.get(productTitle).set(variantTitle, sales);

          // Populate Tally 2 (Aggregated Color)
          const color = extractColorFromTitle(variantTitle);
          if (color) {
              if (!productSalesTally.has(productTitle)) {
                  productSalesTally.set(productTitle, new Map());
              }
              const colorMap = productSalesTally.get(productTitle);
              colorMap.set(color, (colorMap.get(color) || 0) + sales);
          }
        }
      } catch (e) {
        logMessage('warn', `Skipping bad CSV row: ${e.message}`);
      }
    });

    parser.on('end', () => {
       if (productSalesTally.size === 0) {
        logMessage('warn', `No sales data loaded/aggregated from ${CSV_FILE}.`);
      } else {
        logMessage('info', `Sales tally complete. Loaded individual sales for ${variantSalesTally.size} products.`);
        logMessage('info', `Aggregated color sales for ${productSalesTally.size} products.`);
      }
      resolve({ variantSalesTally, productSalesTally });
    });

    parser.on('error', (err) => {
      reject(err);
    });
  });
}


// --- GraphQL Queries and Mutations ---

// Fetch products including options and variants
const GET_PRODUCTS_BY_TAG_QUERY = `
  query getProductsByTag($query: String!, $cursor: String) {
    products(first: 10, after: $cursor, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          images(first: 20) { # Fetch images for reordering
            nodes {
              id
              src
            }
          }
          options {
            id
            name
            position
            values
          }
          variants(first: 50, sortKey: POSITION) { # Fetch variants for reordering
            nodes {
              id
              title
              inventoryQuantity # Keep for potential future logic
              image {
                id
              }
            }
          }
        }
      }
    }
  }
`;

// Mutation 1: Reorder Option Values
const REORDER_OPTIONS_MUTATION = `
  mutation productOptionsReorder($productId: ID!, $options: [OptionReorderInput!]!) {
    productOptionsReorder(productId: $productId, options: $options) {
      product {
        id
        options { name position values }
        # variants(first: 5) { nodes { id title } } # Optional: for logging
      }
      userErrors { field message code }
    }
  }
`;

// Mutation 2: Explicitly reorder Variants
const REORDER_VARIANTS_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product {
        id
      }
      userErrors { field message }
    }
  }
`;

// Mutation 3: Explicitly reorder Images
const REORDER_IMAGES_MUTATION = `
  mutation productImagesReorder($productId: ID!, $imageIds: [ID!]!) {
    productImagesReorder(productId: $productId, imageIds: $imageIds) {
      product {
        id
        images(first: 20) { nodes { id position } }
      }
      userErrors { field message }
    }
  }
`;


// --- Main Script Logic ---

async function main() {
  logMessage('info', `Script started. Targeting products with tag: "${PRODUCT_TAG}"`);

  try {
    // 1. Load configuration from .env file
    const shopURL = process.env.SHOP_URL ? process.env.SHOP_URL.trim() : null;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN ? process.env.SHOPIFY_ACCESS_TOKEN.trim() : null;

    if (!shopURL || !accessToken) {
      logMessage('error', 'Missing SHOP_URL or SHOPIFY_ACCESS_TOKEN in .env file.');
      return;
    }

    logMessage('info', `Loaded SHOP_URL: ${shopURL}`);
    logMessage('info', `Loaded SHOPIFY_ACCESS_TOKEN: ${accessToken.substring(0, 10)}...`);

    // 2. Set up global API variables
    const shopDomain = shopURL.replace('https://', '').replace('/', '');
    shopifyEndpoint = `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;
    shopifyHeaders = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    };
    logMessage('info', 'Shopify API client configured.');

    // 3. Tally sales from local CSV file
    const { variantSalesTally, productSalesTally } = await loadSalesTallyFromCSV();

    // 4. Fetch all products matching the tag (with pagination)
    let allProducts = [];
    let hasNextPage = true;
    let cursor = null;
    const productQuery = `tag:'${PRODUCT_TAG}'`;
    logMessage('info', `Fetching all products matching query: "${productQuery}"...`);

    while (hasNextPage) {
      const productData = await shopifyFetch(GET_PRODUCTS_BY_TAG_QUERY, { query: productQuery, cursor });
      const data = productData.products;
      allProducts.push(...data.edges.map(edge => edge.node));

      hasNextPage = data.pageInfo.hasNextPage;
      cursor = data.pageInfo.endCursor;
      logMessage('info', `Fetched ${allProducts.length} products so far...`);
      await sleep(API_FETCH_DELAY_MS);
    }
    logMessage('info', `Total products found: ${allProducts.length}`);

    // 5. Process each product
    for (const [index, product] of allProducts.entries()) {
      logMessage('info', `--- Processing product ${index + 1} of ${allProducts.length}: "${product.title}" (ID: ${product.id}) ---`);

      try {
        const productTitleKey = product.title.trim();
        const colorSalesMapForProduct = productSalesTally.get(productTitleKey);
        const individualSalesMap = variantSalesTally.get(productTitleKey); // Needed for sorting variants

        if (!colorSalesMapForProduct || !individualSalesMap) {
          logMessage('warn', `No sales data found in CSV for product: "${productTitleKey}". Skipping.`);
          continue;
        }

        if (!product.options || product.options.length === 0 || !product.variants?.nodes || product.variants.nodes.length === 0) {
            logMessage('warn', `Product "${productTitleKey}" has no options or variants fetched. Skipping.`);
            continue;
        }

        // --- Step 5.1: Determine the Final Variant Order based on Sales ---
         const variantsWithSortingData = product.variants.nodes.map(variant => {
          const variantTitleKey = variant.title.trim();
          const color = extractColorFromTitle(variantTitleKey);

          const individualSales = individualSalesMap.get(variantTitleKey) || 0;
          // Use the extracted color (or null) to look up aggregated sales
          const totalColorSales = color ? (colorSalesMapForProduct.get(color) || 0) : 0; // Default to 0 if color is null

          return {
            variant,
            color, // Can be null
            individualSales,
            totalColorSales
          };
        });

        // Sorting function remains the same
        const sortLogic = (a, b) => {
          if (a.totalColorSales !== b.totalColorSales) {
            return b.totalColorSales - a.totalColorSales;
          }
          return b.individualSales - a.individualSales;
        };

        const finalSortedData = variantsWithSortingData.sort(sortLogic);
        const finalSortedVariants = finalSortedData.map(d => d.variant); // This is the desired final order

        logMessage('info', `Desired variant order: ${finalSortedData.map(d => `${d.variant.title} (Color: ${d.color || 'N/A'}, C Sales: ${d.totalColorSales}, I Sales: ${d.individualSales})`).join(' | ')}`);

        // --- Step 5.2: Reorder Option Values using productOptionsReorder ---
        const optionsPayload = [];
        let foundColorOption = false;

        for (const option of product.options) {
          const optionName = option.name;
          let valuesPayload = [];

          if (optionName.toLowerCase() === COLOR_OPTION_NAME.toLowerCase()) {
            foundColorOption = true;
            const currentColorValues = [...option.values]; // Clone to avoid modifying original fetch data

            currentColorValues.sort((valA, valB) => {
                const salesA = colorSalesMapForProduct.get(valA.trim()) || 0;
                const salesB = colorSalesMapForProduct.get(valB.trim()) || 0;
                if (salesB !== salesA) return salesB - salesA;
                return 0; // Keep relative order for ties
            });

             const sortedColorNames = currentColorValues;
             logMessage('info', `New color OPTION VALUE order for "${optionName}": ${sortedColorNames.join(', ')}`);
             valuesPayload = sortedColorNames.map(valName => ({ name: valName }));

          } else {
            // Keep non-color option values in their original order
            logMessage('info', `Keeping original OPTION VALUE order for "${optionName}": ${option.values.join(', ')}`);
            valuesPayload = option.values.map(valName => ({ name: valName }));
          }

          optionsPayload.push({ name: optionName, values: valuesPayload });
        }

        if (!foundColorOption) {
            logMessage('warn', `Could not find option named "${COLOR_OPTION_NAME}" for product "${productTitleKey}". Skipping options reorder.`);
            // Decide if you still want to reorder variants/images directly? For now, skip.
            continue;
        }

        logMessage('info', `Attempting to reorder option values for product ${product.id}...`);
        try {
            const optionsMutationData = await shopifyFetch(REORDER_OPTIONS_MUTATION, {
              productId: product.id,
              options: optionsPayload,
            });
            // Check for userErrors specifically from this mutation
            const optionsErrors = optionsMutationData.productOptionsReorder.userErrors;
             if (optionsErrors.length > 0) {
               logMessage('error', `Failed to reorder option values: ${JSON.stringify(optionsErrors)}`);
               // Consider skipping the next steps if options failed
               continue; // Skip variant/image reorder if options failed
             } else {
               logMessage('info', 'Successfully reordered option values.');
             }
        } catch (e) {
             logMessage('error', `Error during productOptionsReorder mutation: ${e.message}`);
             continue; // Skip subsequent steps if this fails
        }


        // --- Step 5.3: Explicitly Reorder Variants using productVariantsBulkUpdate ---
        logMessage('info',`Attempting to explicitly reorder ${finalSortedVariants.length} variants...`);
        const variantPayload = finalSortedVariants.map((v, i) => ({
          id: v.id,
          position: i + 1,
        }));

        try {
            const variantMutationData = await shopifyFetch(REORDER_VARIANTS_MUTATION, {
              productId: product.id,
              variants: variantPayload,
            });
             const variantErrors = variantMutationData.productVariantsBulkUpdate.userErrors;
             if (variantErrors.length > 0) {
               logMessage('error', `Failed to explicitly reorder variants: ${JSON.stringify(variantErrors)}`);
               // Don't necessarily need to 'continue' here, image reorder might still work
             } else {
               logMessage('info', 'Successfully explicitly reordered variants.');
             }
        } catch(e) {
             logMessage('error', `Error during productVariantsBulkUpdate mutation: ${e.message}`);
        }

        // --- Step 5.4: Explicitly Reorder Images using productImagesReorder ---
        const imageOrder = [];
        const processedImageIds = new Set();

        // Build image order based on the desired final variant order
        for (const variant of finalSortedVariants) {
          if (variant.image && !processedImageIds.has(variant.image.id)) {
            imageOrder.push(variant.image.id);
            processedImageIds.add(variant.image.id);
          }
        }
        // Add remaining images
        for (const image of product.images.nodes) {
          if (!processedImageIds.has(image.id)) {
            imageOrder.push(image.id);
          }
        }

        const imageIdPayload = imageOrder;

        if (imageIdPayload.length > 0) {
          logMessage('info', `Attempting to explicitly reorder ${imageIdPayload.length} images...`);
          try {
              const imageMutationData = await shopifyFetch(REORDER_IMAGES_MUTATION, {
                productId: product.id,
                imageIds: imageIdPayload,
              });
              const imageErrors = imageMutationData.productImagesReorder.userErrors;
              if (imageErrors.length > 0) {
                logMessage('error', `Failed to explicitly reorder images: ${JSON.stringify(imageErrors)}`);
              } else {
                logMessage('info', 'Successfully explicitly reordered images.');
              }
          } catch (e) {
               logMessage('error', `Error during productImagesReorder mutation: ${e.message}`);
          }
        } else {
          logMessage('info', 'No images associated with variants found to reorder.');
        }

      } catch (e) {
        logMessage('error', `Unknown error processing product ${product.id}: ${e.message}\n${e.stack}`);
      }

      logMessage('info', `--- Finished product: "${product.title}". Waiting ${API_MUTATION_DELAY_MS}ms ---`);
      await sleep(API_MUTATION_DELAY_MS);
    }

  } catch (e) {
    logMessage('error', `Fatal Script Error: ${e.message}\n${e.stack}`);
  } finally {
    logMessage('info', 'Script finished.');
    logStream.end();
  }
}

// Run the script
main().catch(e => {
  logMessage('error', `Unhandled script failure: ${e.message}`);
  logStream.end();
});

