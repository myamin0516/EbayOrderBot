// Import required modules
const path = require('path');
const { google } = require('googleapis');
const xml2js = require('xml2js');
const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();

// Dynamic import for node-fetch
let fetch;
(async () => {
    fetch = (await import('node-fetch')).default;
})();

// DynamoDB table to store processed orders
const tableName = 'ProcessedOrders';

/**
 * Determines the game and code type based on the eBay listing title.
 * The combination of game and code must be unique in the eBay listing title.
 * @param {string} itemTitle - The title of the eBay listing item.
 * @returns {Object} An object containing the game and codeRange.
 */
function getGameAndCodeFromListing(itemTitle) {
    const lowerCaseTitle = itemTitle.toLowerCase();
    
    let game = '';
    if (lowerCaseTitle.includes('game1')) {
        game = 'Game1';
    } else if (lowerCaseTitle.includes('game2')) {
        game = 'Game2';
    } else {
        throw new Error('Unknown game type');
    }

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

/**
 * Checks if the order has already been processed to prevent duplicates.
 * @param {string} orderId - The eBay Order ID.
 * @returns {boolean} True if the order is already processed, false otherwise.
 */
async function isOrderProcessed(orderId) {
    const params = {
        TableName: tableName,
        Key: { OrderID: orderId }
    };
    const result = await dynamoDb.get(params).promise();
    return !!result.Item;
}

/**
 * Marks the order as processed by storing its Order ID in DynamoDB.
 * @param {string} orderId - The eBay Order ID.
 */
async function markOrderAsProcessed(orderId) {
    const params = {
        TableName: tableName,
        Item: { OrderID: orderId }
    };
    await dynamoDb.put(params).promise();
}

/**
 * AWS Lambda handler for processing incoming order notifications.
 */
exports.handler = async (event, context) => {
    console.log("EVENT: \n" + JSON.stringify(event, null, 2));
    const sheetId = 'replace with google sheet id containing your codes';

    try {
        if (event.headers['Content-Type']?.toLowerCase().includes('xml')) {
            await processOrder(event.body, sheetId);
            return { statusCode: 200, body: JSON.stringify({ message: 'Order processing started' }) };
        } else {
            throw new Error('Invalid content type, expected XML');
        }
    } catch (error) {
        console.error('Error processing the event:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to process orders' }) };
    }
};

/**
 * Parses the incoming XML body and processes the order.
 * @param {string} xmlBody - The XML payload from the eBay notification.
 * @param {string} sheetId - The Google Sheets ID containing the codes.
 */
async function processOrder(xmlBody, sheetId) {
    const xmlParser = new xml2js.Parser({ explicitArray: false });
    const ordersData = await xmlParser.parseStringPromise(xmlBody);

    const body = ordersData['soapenv:Envelope']['soapenv:Body'];
    const response = body.GetItemTransactionsResponse;
    const transactionArray = response.TransactionArray;

    const orderId = transactionArray.Transaction.ContainingOrder.OrderID;

    if (await isOrderProcessed(orderId)) {
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

    const { game, codeRange } = getGameAndCodeFromListing(itemTitle);
    const range = `${game}!${codeRange}`;
    console.log({ range });

    if (paymentStatus === 'NoPaymentFailure') {
        const productCode = await getNextAvailableCode(sheetId, range, quantityPurchased);
        const messageContent = `Thanks for buying, here's your ${itemTitle} code(s): ${productCode.join(', ')}`;

        await sendMessageToBuyer(buyerUsername, messageContent, itemId);
        await createShippingFulfillment(orderId, itemId, transactionId);
        await markOrderAsProcessed(orderId);
    } else {
        console.log(`Order ${orderId} is not paid yet. Skipping.`);
    }
}

/**
 * Fetches the next available code from Google Sheets.
 * @param {string} sheetId - The Google Sheets ID.
 * @param {string} codeRange - The range in the sheet where codes are stored.
 * @param {number} quantityPurchased - The number of codes to fetch.
 * @returns {string[]} A list of available codes.
 */
async function getNextAvailableCode(sheetId, codeRange, quantityPurchased) {
    try {
        const keyFilePath = path.resolve('replace with google service account key');
        const authSheets = new google.auth.GoogleAuth({
            keyFile: keyFilePath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const sheets = google.sheets({ version: 'v4', auth: await authSheets.getClient() });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: codeRange,
        });

        const rows = response.data.values;
        if (rows && rows.length) {
            const codes = [];
            let codesFetched = 0;

            const startColumn = codeRange.split(':')[0].slice(-1);
            const usedColumn = String.fromCharCode(startColumn.charCodeAt(0) + 1);

            for (let i = 0; i < rows.length && codesFetched < quantityPurchased; i++) {
                const code = rows[i][0];
                if (!rows[i][1] || rows[i][1] !== 'used') {
                    await sheets.spreadsheets.values.update({
                        spreadsheetId: sheetId,
                        range: `${codeRange.split('!')[0]}!${usedColumn}${i + 1}`,
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

            return codes;
        } else {
            throw new Error('No data found.');
        }
    } catch (error) {
        console.error('Error fetching data from Google Sheets:', error);
        throw error;
    }
}

/**
 * Sends a message to the buyer via the eBay API.
 * @param {string} buyerUsername - The eBay username of the buyer.
 * @param {string} messageContent - The message content to be sent.
 * @param {string} itemId - The eBay Item ID of the purchase.
 */
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

/**
 * Marks the eBay order as shipped via the eBay API.
 * @param {string} orderId - The eBay Order ID.
 * @param {string} itemId - The eBay Item ID.
 * @param {string} transactionId - The eBay transaction ID.
 */
async function createShippingFulfillment(orderId, itemId, transactionId) {
    const ebayApiUrl = 'https://api.ebay.com/ws/api.dll';

    const xmlBody = `
      <?xml version="1.0" encoding="utf-8"?>
      <CompleteSaleRequest xmlns="urn:ebay:apis:eBLBaseComponents">
        <RequesterCredentials>
          <eBayAuthToken>${auth_token_goes_here}</eBayAuthToken>
        </RequesterCredentials>
        <OrderID>${orderId}</OrderID>
        <ItemID>${itemId}</ItemID>
        <TransactionID>${transactionId}</TransactionID>
        <Shipped>true</Shipped>
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
        console.log('Shipping fulfilled for order', data);
    } catch (error) {
        console.error('Error marking shipping:', error);
        throw error;
    }
}
