Shopify Variant & Image Sorter Script

This Node.js script automates the merchandising of your products by sorting variants and their associated images based on sales performance.

It processes all products within a specific collection, fetches their variants sorted by units sold, and then updates the product so that:

Variants are re-ordered from most-sold to least-sold.

Out-of-Stock variants are automatically moved to the end of the list.

Product Images are re-ordered to match the new variant order. The image for the #1 variant becomes the #1 (main) product image.

How to Use

Step 1: Install Node.js

If you don't already have it, download and install Node.js from the official website: https://nodejs.org/ (use the "LTS" version).

Step 2: Create a Shopify Custom App

You need to give this script permission to read and write product data.

In your Shopify Admin, go to Apps > Apps and sales channels > Develop apps.

Click Create an app.

Give it a name, like "Variant Sorter Script".

Click Configure Admin API scopes.

Find and check the following permissions:

read_products

write_products

read_orders (This is required by Shopify to use the SOLD_QUANTITY sort key)

Click Save.

Go to the API credentials tab.

Click Install app and confirm.

You will see an Admin API access token. Copy this token. Do not share it with anyone.

Step 3: Set Up the Project

Create a new folder on your computer (e.g., shopify-sorter).

Save all the files from this project (package.json, .env.example, sort-variants.js, README.md) into that folder.

Rename .env.example to just .env.

Open the new .env file in a text editor and fill in your details:

SHOP_DOMAIN: Your shop's .myshopify.com domain (e.g., my-cool-store.myshopify.com).

ADMIN_API_ACCESS_TOKEN: The token you copied in Step 2.

Step 4: Install Dependencies

Open your computer's terminal (like Terminal on Mac, or Command Prompt/PowerShell on Windows).

Navigate to the folder you created:

cd path/to/shopify-sorter


Run this command to install the necessary libraries:

npm install


Step 5: Run the Script

(Optional) Open sort-variants.js and change the COLLECTION_HANDLE variable at the top if you want to target a different collection.

From your terminal, run the script:

node sort-variants.js


The script will now run. You will see its progress in your terminal, and a full log will be saved to sort-variants.log in the same folder. You can go to your Shopify admin to see the products update in real-time.