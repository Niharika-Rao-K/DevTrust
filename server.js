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
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contractJSON = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));
const contractABI = contractJSON.abi;
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

// --- Utility Functions ---

// Extract Wallet Address
function extractWallet(text) {
    if (!text) return null;
    const regex = /0x[a-fA-F0-9]{40}/;
    const match = text.match(regex);
    return match ? match[0] : null;
}

// Add Event to Queue
function addToQueue(walletAddress, prId, type) {
    const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));

    if (db.find(item => item.prId === prId)) {
        console.log(`⚠️ PR #${prId} already exists in DB. Skipping...`);
        return;
    }

    db.push({
        prId,
        wallet: walletAddress,
        type,
        status: "PENDING_BLOCKCHAIN",
        timestamp: new Date().toISOString()
    });

    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    console.log(`📥 Added PR #${prId} to queue`);
}

// --- Webhook Endpoint ---
app.post("/webhook", (req, res) => {
    console.log("\n==============================");
    console.log("📩 Webhook Received");

    const event = req.headers["x-github-event"];
    console.log("Event:", event);

    if (event !== "pull_request") {
        console.log("⏭ Ignored non-PR event");
        return res.status(200).send("Ignored");
    }

    const { action, pull_request } = req.body;

    console.log("Action:", action);

    if (!pull_request) {
        console.log("❌ No pull_request object found");
        return res.status(200).send("Invalid payload");
    }

    if (action === "closed") {
        const prId = pull_request.number.toString();
        console.log(`🔍 Processing PR #${prId}`);

        const userWallet = extractWallet(pull_request.body);
        console.log("Extracted Wallet:", userWallet);

        if (!userWallet) {
            console.log(`⚠️ No wallet found in PR #${prId}`);
            return res.status(200).send("No wallet");
        }

        if (pull_request.merged === true) {
            console.log(`✅ PR #${prId} MERGED`);
            addToQueue(userWallet, prId, "SUCCESS");
        } else {
            console.log(`❌ PR #${prId} CLOSED WITHOUT MERGE`);
            addToQueue(userWallet, prId, "REJECTED");
        }
    }

    res.status(200).send("Webhook Processed");
});

// --- API Endpoint ---
app.get("/api/logs", (req, res) => {
    const data = fs.readFileSync(DB_PATH, "utf8");
    res.json(JSON.parse(data));
});

// --- Blockchain Processor ---
async function processQueue() {
    let db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const pending = db.filter(item => item.status === "PENDING_BLOCKCHAIN");

    if (pending.length === 0) {
        console.log("⏳ No pending events");
        return;
    }

    console.log(`⛓️ Processing ${pending.length} pending events...`);

    for (const item of pending) {
        try {
            let tx;

            if (item.type === "SUCCESS") {
                console.log(`🚀 Minting reward for PR #${item.prId}`);
                tx = await contract.addRecord(item.wallet, item.prId);
            } else {
                console.log(`🧨 Slashing PR #${item.prId}`);
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

// --- Run Processor (Reduced time for testing) ---
setInterval(processQueue, 10000); // 10 sec for testing

// --- Root Route (for browser testing) ---
app.get("/", (req, res) => {
    res.send("🚀 DevTrust Backend is Live");
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`🚀 Webhook Listener running on port ${PORT}`);
    console.log(`⚙️ Blockchain Processor active (10s intervals)`);
});
