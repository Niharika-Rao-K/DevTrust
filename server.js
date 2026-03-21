const express = require("express");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

// --- Configuration & Paths ---
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "db.json");
const ABI_PATH = path.join(__dirname, "DevTrust.json");

// --- Initialize Database File if it doesn't exist ---
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
}

// --- Blockchain Setup ---
const provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contractABI = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

// --- Utility Functions ---

// 1. Extract Wallet Address from PR Description
function extractWallet(text) {
    if (!text) return null;
    const regex = /0x[a-fA-F0-9]{40}/;
    const match = text.match(regex);
    return match ? match[0] : null;
}

// 2. Add Event to local Queue (db.json)
function addToQueue(walletAddress, prId, type) {
    const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    
    // Avoid duplicates
    if (db.find(item => item.prId === prId)) return;

    db.push({
        prId,
        wallet: walletAddress,
        type, // "SUCCESS" or "REJECTED"
        status: "PENDING_BLOCKCHAIN",
        timestamp: new Date().toISOString()
    });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// --- Endpoints ---

// 1. GitHub Webhook Listener
app.post("/webhook", (req, res) => {
    const { action, pull_request } = req.body;

    if (action === "closed") {
        const prId = pull_request.number.toString();
        const userWallet = extractWallet(pull_request.body);

        if (!userWallet) {
            console.log(`⚠️ PR #${prId} closed but no wallet address found in description.`);
            return res.status(200).send("No wallet found");
        }

        if (pull_request.merged === true) {
            console.log(`✅ PR #${prId} MERGED. Queuing for Reward...`);
            addToQueue(userWallet, prId, "SUCCESS");
        } else {
            console.log(`❌ PR #${prId} REJECTED. Queuing for Slashing...`);
            addToQueue(userWallet, prId, "REJECTED");
        }
    }
    res.status(200).send("Webhook Processed");
});

// 2. Data API for Member C (Frontend)
app.get("/api/logs", (req, res) => {
    const data = fs.readFileSync(DB_PATH, "utf8");
    res.json(JSON.parse(data));
});

// --- Background Blockchain Processor ---
async function processQueue() {
    let db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const pending = db.filter(item => item.status === "PENDING_BLOCKCHAIN");

    if (pending.length === 0) return;

    console.log(`⛓️ Processing ${pending.length} pending events...`);

    for (const item of pending) {
        try {
            let tx;
            if (item.type === "SUCCESS") {
                console.log(`🚀 Minting reward for PR #${item.prId}...`);
                tx = await contract.addRecord(item.wallet, item.prId);
            } else {
                console.log(`🧨 Slashing/Rejecting for PR #${item.prId}...`);
                // Note: Ensure Member A has 'slashRecord' or similar in the contract
                tx = await contract.slashRecord(item.wallet, item.prId); 
            }

            const receipt = await tx.wait();
            item.status = "COMPLETED";
            item.txHash = receipt.hash;
            console.log(`✨ Success! Tx: ${receipt.hash}`);

        } catch (error) {
            console.error(`❌ Error for PR #${item.prId}:`, error.shortMessage || error.message);
            item.status = "FAILED";
            item.error = error.message;
        }
    }

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Run processor every 60 seconds
setInterval(processQueue, 60000);

app.listen(PORT, () => {
    console.log(`🚀 Webhook Listener running on port ${PORT}`);
    console.log(`⚙️ Blockchain Processor active (60s intervals)`);
});
