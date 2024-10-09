# eBay Order Automation
This project is intended for the resale of one-time-use codes in online games particularly on eBay. Whether it be to unlock items, characters, pets, etc. managing a bunch of codes for resale can be a pain. Especially with high sales volume, manually sending all the codes is inefficient. This code aims to streamlines the process of handling orders so that all you'll have to worry about is a spreadsheet.

## How it Works
The application processes incoming order notifications, checks for payment status, retrieves available codes from a Google Sheet, and sends messages to buyers.
1. **Order Notification Processing**: The application listens for incoming order notifications via webhooks.
2. **Payment Status Verification**: It checks whether the order has been paid from ebay notifications event body.
3. **Code Retrieval**: It retrieves available codes from a specified range in a Google Sheet and marks it used.
4. **Message Delivery**: It sends the retrieved codes to the buyer through eBay's messaging system and marks as shipped.
5. **Order Tracking**: It records order ids as processed in a database to avoid duplicate messages (explained later).

## Technologies Used
- **Node.js**: The backend framework for building the application
- **AWS**: Used for DynamoDB to store processed order information
- **Google Sheets API**: For managing and retrieving available codes
- **eBay API**: For processing orders and sending messages to buyers

## Table of Contents
- [Requirements](#requirements)
- [Configuration](#configuration)
- [Setup](#setup)
- [Disclaimer](#disclaimer)

## Requirements
Before starting with the setup, you'll need the following accounts and API credentials:
- **eBay Developer Account** Obviously, you'll need to create an eBay developer account (linked with your seller account) and obtain production API keys. Additionally, you must subscribe to fixed price transaction notifications, which will trigger AWS Lambda or your alternative backend service whenever an order is placed.
- **Google Service Account** The project relies on Google Sheets to store and retrieve codes. You need to create a Google Service Account and get your JSON key file.
- **AWS Account (or alternative cloud service)** Create an AWS account, configure AWS Lambda for handling webhook events (API gateway) and DynamoDB to store the processed order IDs.
- **Google Sheets Setup** You will also need to set up a Google Sheet containing the codes you plan to sell. The sheet must follow a specific structure to allow the application to correctly mark used codes and retrieve available ones.

## Configuration
1. **eBay Developer Configuration**
   - Obtain your App ID, Dev ID, and Cert ID.
   - Generate an eBay OAuth Token to make authenticated API requests.
   - Setup notifications and subscribe to Fixed Price Transaction Notifications. You will use the API Gateway URL from AWS Lambda. This allows eBay to notify your webhook whenever an item is sold at a fixed price.

    **API Endpoints**
   - AddMemberMessageAAQToPartner for sending messages to buyers.
   - CompleteSale for marking items as shipped.

2. **Google Cloud Service Configuration**
   - **Create a Google Cloud Project**
   - Navigate to the Google Cloud Console, create a new project, and enable the Google Sheets API.
   - **Create a Service Account**
   - Go to IAM & Admin > Service Accounts, create a new account, and grant the necessary roles (e.g., Editor and Sheets API roles).
   - Download the service account’s JSON key file. This will be used to authenticate the application with Google Sheets.
   - **Share the Google Sheet**
   - Create a new Google Sheet with two columns. The first column (A) will hold the codes, and the second column (B) will be marked as "used" once a code is issued.
   - Share the Google Sheet with edit permissions to your service account email address, which can be found in the downloaded JSON key file.
3. **AWS Lambda Configuration**
   - **Create an AWS Lambda Function**
   - Go to the AWS Lambda Console, create a new Lambda function, and choose the Node.js runtime.
   - Upload the project code (e.g., src/index.js)
   - **Set Environment Variables**
   - EBAY_API_TOKEN: Your eBay OAuth token.
   - EBAY_CLIENT_ID: Your eBay client id goes here
   - EBAY_DEV_NAME: Your eBay dev name goes here
   - EBAY_CLIENT_SECRET: Your eBay client secret goes here
   - GOOGLE_SHEET_ID: The ID of the Google Sheet that contains your codes.
   - GOOGLE_SERVICE_ACCOUNT_KEY: The path to your Google Cloud JSON key file.
   - **DynamoDB Table Setup**
   - Create a DynamoDB table called ProcessedOrders with the primary key OrderID (string).
   - This table is used to track which orders have already been processed to avoid duplicate code dispatching. Necessary because of this https://developer.ebay.com/support/kb-article?KBid=961
   - **API Gateway Setup**
   - Create a new API in Amazon API Gateway.
   - Configure a POST endpoint and link it to your Lambda function. This will serve as the webhook that eBay calls when an order is placed.
   - Deploy the API and note the URL endpoint, which you’ll use to configure the webhook in eBay.

## Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/myamin0516/ebay-order-automation.git```
2. Install dependencies:
   ```bash
   npm install googleapis xml2js node-fetch aws-sdk```
3. Zip files and upload to AWS Lambda.

## Disclaimer
This project is intended to assist with managing and automating the resale of one-time-use codes, such as for in-game items or digital content, through platforms like eBay. However, many games, publishers, and developers prohibit the resale of their codes or digital content. It is your responsibility to ensure that you are in compliance with the terms and conditions of the relevant game, service, or platform before using this tool. The creator of this project is not liable for any misuse or violation of third-party policies, and I strongly advise reviewing the applicable legal agreements before engaging in the resale of any codes.

By using this project, you acknowledge that you are responsible for the lawful usage of this tool.
