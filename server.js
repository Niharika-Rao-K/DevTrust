require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { ethers } = require('ethers');

const app = express();
app.use(bodyParser.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const LOGS_PATH = './logs.json';
const DB_PATH = './db.json';
const CONTRACT_PATH = "./DevTrust.json";

// --- BLOCKCHAIN SETUP ---
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Load ABI
const contractJson = JSON.parse(fs.readFileSync(CONTRACT_PATH));
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractJson.abi, wallet);

/**
 * 1. WEBHOOK ENDPOINT
 * Listens for GitHub events and extracts wallet addresses from PR descriptions.
 */
app.post('/webhook', (req, res) => {
    const event = req.headers['x-github-event'];
    const { action, pull_request } = req.body;

    if (event === 'pull_request' && action === 'closed' && pull_request.merged === true) {
        console.log(`\n🔔 Merged PR Detected: #${pull_request.number} by ${pull_request.user.login}`);

        const walletRegex = /0x[a-fA-F0-9]{40}/;
        const foundWallet = pull_request.body ? pull_request.body.match(walletRegex) : null;

        if (foundWallet) {
            const newLog = {
                prId: pull_request.number,
                user: pull_request.user.login,
                wallet: foundWallet[0],
                status: "PENDING_BLOCKCHAIN",
                timestamp: new Date().toISOString()
            };

            // --- FIXED SECTION START ---
            let logs = [];
            if (fs.existsSync(LOGS_PATH)) {
                try {
                    logs = JSON.parse(fs.readFileSync(LOGS_PATH, 'utf8') || "[]");
                } catch (e) { logs = []; }
            }
            // --- FIXED SECTION END ---

            logs.push(newLog);
            fs.writeFileSync(LOGS_PATH, JSON.stringify(logs, null, 2));

            console.log(`✅ Added to queue for wallet: ${foundWallet[0]}`);
        } else {
            console.log("⚠️ No wallet address found in PR description. Skipping.");
        }
    }
    res.status(200).send('OK');
});
/**
 * 2. BLOCKCHAIN PROCESSOR
 * Automatically processes PENDING_BLOCKCHAIN entries every 60 seconds.
 */
async function processQueue() {
    if (!fs.existsSync(LOGS_PATH)) return;

    let logs = JSON.parse(fs.readFileSync(LOGS_PATH, 'utf8') || "[]");
    const pending = logs.filter(l => l.status === "PENDING_BLOCKCHAIN");

    if (pending.length === 0) return;

    console.log(`\n⛓️  Processing ${pending.length} pending rewards...`);

    for (let reward of logs) {
        if (reward.status !== "PENDING_BLOCKCHAIN") continue;

        try {
            // Mark as processing immediately to prevent duplicate runs
            reward.status = "PROCESSING";
            fs.writeFileSync(LOGS_PATH, JSON.stringify(logs, null, 2));

            console.log(`🚀 Minting reward for PR #${reward.prId}...`);
            
            // Call the 'addRecord' or 'mint' function on your contract
            const tx = await contract.addRecord(reward.wallet, reward.prId);
            const receipt = await tx.wait();

            reward.status = "COMPLETED";
            reward.txHash = receipt.hash;

            // Update Transaction History (db.json)
            updateAuditTrail(reward);
            
            console.log(`✨ Success! Tx: ${receipt.hash}`);
        } catch (error) {
            reward.status = "FAILED";
            console.error(`❌ Blockchain Error for PR #${reward.prId}:`, error.message);
        }
        
        // Save status update
        fs.writeFileSync(LOGS_PATH, JSON.stringify(logs, null, 2));
    }
}

function updateAuditTrail(record) {
    let db = { transactions: [] };
    if (fs.existsSync(DB_PATH)) {
        db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{"transactions":[]}');
    }
    db.transactions.push(record);
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Start Server and Set interval for processor
app.listen(PORT, () => {
    console.log(`🚀 Webhook Listener running on port ${PORT}`);
    console.log(`⚙️  Blockchain Processor active (60s intervals)`);
    
    // Run the queue processor every 60 seconds
    setInterval(processQueue, 60000);
});
