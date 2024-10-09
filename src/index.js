// Import required modules
// Gotta refactor the get game and code function, probably a dictionary instead
// Restructure and organize for readability
const path = require('path');
const { google } = require('googleapis');
const xml2js = require('xml2js')
const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
// Use dynamic import for node-fetch
let fetch;

(async () => {
    fetch = (await import('node-fetch')).default;
})();

// Table to store processed orders
const tableName = 'ProcessedOrders';

// Determines the game and code based on the ebay listing item title
// 
// COMBINATION OF THE GAME AND CODE MUST BE UNIQUE AND IN EBAY LISTING TITLE

// Game and code correspond to sheet and column set
function getGameAndCodeFromListing(itemTitle) {
    const lowerCaseTitle = itemTitle.toLowerCase();
    
    // Check for game
    let game = '';
    if (lowerCaseTitle.includes('game1')) {
        game = 'Game1';
    } else if (lowerCaseTitle.includes('game2')) {
        game = 'Game2';
    } else {
        throw new Error('Unknown game type');
    }

    // Check for specific code type
    let codeRange = '';
    if (lowerCaseTitle.includes('item32')) {
        codeRange = 'A:B';
    } else if (lowerCaseTitle.includes('item99')) { 
        codeRange = 'C:D';
    } else {
        throw new Error('Unknown code type');
    }

    return { game, codeRange };
}

// Check if order has already been processed (duplicate order id)
// This is necessary because of number 2 here https://developer.ebay.com/support/kb-article?KBid=961
async function isOrderProcessed(orderId) {
    const params = {
        TableName: tableName,
        Key: { OrderID: orderId }
    };

    const result = await dynamoDb.get(params).promise();
    return !!result.Item;  // Returns true if the order was already processed
}

// Mark the order as processed
async function markOrderAsProcessed(orderId) {
    const params = {
        TableName: tableName,
        Item: { OrderID: orderId }
    };

    await dynamoDb.put(params).promise();
}


// Main event handler
exports.handler = async (event, context) => {
    console.log("EVENT: \n" + JSON.stringify(event, null, 2));
    const sheetId = 'replace with google sheet id containing your codes';

    try {
        if (event.headers['Content-Type']?.toLowerCase().includes('xml')) {
            const response = { statusCode: 200, body: JSON.stringify({ message: 'Order processing started' }) };

            await processOrder(event.body, sheetId);

            return response
        } else {
            throw new Error('Invalid content type, expected XML');
        }
    } catch (error) {
        console.error('Error processing the event:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to process orders' })
        };
    }
};

// Function to process the order in the background
async function processOrder(xmlBody, sheetId) {
    const xmlParser = new xml2js.Parser({ explicitArray: false });
    const ordersData = await xmlParser.parseStringPromise(xmlBody);

    // Extract necessary data
    const body = ordersData['soapenv:Envelope']['soapenv:Body'];
    const response = body.GetItemTransactionsResponse;
    const transactionArray = response.TransactionArray;

    // Extract necessary information from the order data
    const orderId = transactionArray.Transaction.ContainingOrder.OrderID;

    // Check if the order has already been processed
    const alreadyProcessed = await isOrderProcessed(orderId);
    if (alreadyProcessed) {
        console.log(`Order ${orderId} already processed. Skipping.`);
        return;
    }

    const transactionId = transactionArray.Transaction.TransactionID;
    const itemTitle = response.Item.Title;
    const itemId = response.Item.ItemID;
    const buyerUsername = transactionArray.Transaction.Buyer.UserID;
    const paymentStatus = transactionArray.Transaction.Status.eBayPaymentStatus;
    const quantityPurchased = parseInt(transactionArray.Transaction.QuantityPurchased, 10);

    console.log({ orderId, transactionId, itemTitle, itemId, buyerUsername, paymentStatus, quantityPurchased });

    // Determine game and code from listing title then assign appropriate sheet and columns
    const { game, codeRange } = getGameAndCodeFromListing(itemTitle);
    const range = `${game}!${codeRange}`;

    console.log({ range })

    // Check if payment went through
    if (paymentStatus === 'NoPaymentFailure') {
        // Get next available code from Google Sheets and format message
        const productCode = await getNextAvailableCode(sheetId, range, quantityPurchased);
        const messageContent = `Thanks for buying, here's your ${itemTitle} code(s): ${productCode.join(', ')}`;

        // Send the message to the buyer and log the used code
        await sendMessageToBuyer(buyerUsername, messageContent, itemId);
        console.log(`These ${itemTitle} code(s) were used: ${productCode.join(', ')}`);
        
        // Mark as shipped
        await createShippingFulfillment(orderId, itemId, transactionId);

        // Mark the order id as processed
        await markOrderAsProcessed(orderId)
    } else {
        console.log(`Order ${orderId} is not paid yet. Skipping.`);
    }
}

// Function to get the next available code from Google Sheets
// You'll need a google service account
async function getNextAvailableCode(sheetId, codeRange, quantityPurchased) {
    try {

        // Setup Google service account and authenticate
        const keyFilePath = path.resolve('replace with google service account key');
        const authSheets = new google.auth.GoogleAuth({
            keyFile: keyFilePath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        // Sheets API setup
        const sheets = google.sheets({ version: 'v4', auth: await authSheets.getClient() });

        // Define the sheet and working range
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: codeRange,
        });

        const rows = response.data.values;
        if (rows && rows.length) {
            const codes = [];
            let codesFetched = 0;

            const startColumn = codeRange.split(':')[0].slice(-1);  // Extract the start column letter (e.g., 'A' from 'A:B')
            const usedColumn = String.fromCharCode(startColumn.charCodeAt(0) + 1); // Next column (e.g., 'B' from 'A')

            // Find the required number of available codes
            for (let i = 0; i < rows.length && codesFetched < quantityPurchased; i++) {
                const code = rows[i][0];

                // Check if column B is already marked as "used"
                if (!rows[i][1] || rows[i][1] !== 'used') {

                    // Mark adjacent column as used dynamically
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: sheetId,
                        range: `${codeRange.split('!')[0]}!${usedColumn}${i + 1}`, // Update column B for the same row
                        valueInputOption: 'RAW',
                        requestBody: { values: [['used']] },
                    });

                    codes.push(code);
                    codesFetched++;
                }
            }

            if (codesFetched < quantityPurchased) {
                throw new Error('Not enough available codes found.');
            }

            return codes; // Return the list of codes
        } else {
            throw new Error('No data found.');
        }
    } catch (error) {
        console.error('Error fetching data from Google Sheets:', error);
        throw error;
    }
}

// Function to send message to buyer
// You'll need an ebay developer account
async function sendMessageToBuyer(buyerUsername, messageContent, itemId) {
    const ebayApiUrl = 'https://api.ebay.com/ws/api.dll';

    const xmlBody = `
      <?xml version="1.0" encoding="utf-8"?>
      <AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${auth_token_goes_here}</eBayAuthToken>
        </RequesterCredentials>
        <ItemID>${itemId}</ItemID>
        <MemberMessage>
          <Subject>Message from Seller</Subject>
          <Body>${messageContent}</Body>
          <QuestionType>General</QuestionType>
          <RecipientID>${buyerUsername}</RecipientID>
        </MemberMessage>
      </AddMemberMessageAAQToPartnerRequest>
    `;

    try {
        const response = await fetch(ebayApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-CALL-NAME': 'AddMemberMessageAAQToPartner',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-APP-NAME': client_id_goes_here,
                'X-EBAY-API-DEV-NAME': dev_name_goes_here,
                'X-EBAY-API-CERT-NAME': client_secret_goes_here,
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967'
            },
            body: xmlBody
        });

        const data = await response.text();
        console.log('Message sent to buyer', data);
    } catch (error) {
        console.error('Error sending message:', error);
        throw error;
    }
}
// Function to create shipping fulfillment
async function createShippingFulfillment(orderId, itemId, transactionId, isShipped = true) {
    const ebayApiUrl = 'https://api.ebay.com/ws/api.dll';

    const xmlBody = `
      <?xml version="1.0" encoding="utf-8"?>
      <CompleteSaleRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${auth_token_goes_here}</eBayAuthToken>
        </RequesterCredentials>
        <OrderID>${orderId}</OrderID>
        <Shipped>${isShipped}</Shipped>
        <ItemID>${itemId}</ItemID>
        <TransactionID>${transactionId}</TransactionID>
      </CompleteSaleRequest>
    `;

    try {
        const response = await fetch(ebayApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml',
                'X-EBAY-API-CALL-NAME': 'CompleteSale',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-APP-NAME': client_id_goes_here,
                'X-EBAY-API-DEV-NAME': dev_name_goes_here,
                'X-EBAY-API-CERT-NAME': client_secret_goes_here,
                'X-EBAY-API-COMPATIBILITY-LEVEL': '967'
            },
            body: xmlBody
        });

        const data = await response.text();
        console.log('Shipping fulfillment created:', data);
    } catch (error) {
        console.error('Error creating shipping fulfillment:', error);
        throw error;
    }
}