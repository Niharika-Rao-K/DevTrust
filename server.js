const express = require("express");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const cors = require("cors"); // Added for Member C
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(cors()); // Enable CORS for frontend integration

// --- Configuration & Paths ---
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "db.json");
const ABI_PATH = path.join(__dirname, "DevTrust.json");

// --- Initialize Database File with correct structure ---
if (!fs.existsSync(DB_PATH)) {
    const initialDB = { users: [], logs: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initialDB, null, 2));
}

// --- Blockchain Setup ---
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const contractJSON = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));
const contractABI = contractJSON.abi;
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, contractABI, wallet);

// --- Utility Functions ---

// Extract Wallet Address from text
function extractWallet(text) {
    if (!text) return null;
    const regex = /0x[a-fA-F0-9]{40}/;
    const match = text.match(regex);
    return match ? match[0] : null;
}

// Helper to Read/Write DB safely
const readDB = () => JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
const writeDB = (data) => fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

// --- API Endpoints ---

// 1. User Registration (For Member C to link GitHub + Wallet)
app.post("/api/register", (req, res) => {
    const { githubUsername, walletAddress } = req.body;
    const db = readDB();

    if (!githubUsername || !walletAddress) {
        return res.status(400).json({ error: "Missing username or wallet" });
    }

    const existingUser = db.users.find(u => u.github === githubUsername);
    if (!existingUser) {
        db.users.push({ github: githubUsername, wallet: walletAddress });
        writeDB(db);
        console.log(`👤 Registered new user: ${githubUsername}`);
        return res.json({ message: "Registration successful" });
    }
    res.json({ message: "User already registered" });
});

// 2. Get Logs (For Member C's Dashboard)
app.get("/api/logs", (req, res) => {
    const db = readDB();
    res.json(db.logs);
});

// --- Webhook Endpoint ---
app.post("/webhook", (req, res) => {
    console.log("\n==============================");
    const event = req.headers["x-github-event"];
    
    if (event !== "pull_request") return res.status(200).send("Ignored");

    const { action, pull_request } = req.body;
    if (action === "closed") {
        const prId = pull_request.number.toString();
        const githubUser = pull_request.user.login;
        
        // Step 1: Try to find wallet in PR Body
        let userWallet = extractWallet(pull_request.body);
        
        // Step 2: If not in body, look up in our DB
        if (!userWallet) {
            const db = readDB();
            const found = db.users.find(u => u.github === githubUser);
            if (found) userWallet = found.wallet;
        }

        if (!userWallet) {
            console.log(`⚠️ No wallet found for ${githubUser} in PR #${prId}`);
            return res.status(200).send("No wallet found");
        }

        const db = readDB();
        // Prevent duplicates
        if (db.logs.find(item => item.prId === prId)) return res.status(200).send("Duplicate");

        db.logs.push({
            prId,
            githubUser,
            wallet: userWallet,
            type: pull_request.merged ? "SUCCESS" : "REJECTED",
            status: "PENDING_BLOCKCHAIN",
            timestamp: new Date().toISOString()
        });

        writeDB(db);
        console.log(`📥 PR #${prId} added to queue for ${githubUser}`);
    }
    res.status(200).send("Processed");
});

// --- Blockchain Processor ---
async function processQueue() {
    let db = readDB();
    const pending = db.logs.filter(item => item.status === "PENDING_BLOCKCHAIN");

    if (pending.length === 0) return;

    for (const item of pending) {
        try {
            console.log(`🚀 Processing PR #${item.prId} on Sepolia...`);
            let tx;
            if (item.type === "SUCCESS") {
                tx = await contract.addRecord(item.wallet, item.prId);
            } else {
                tx = await contract.slashRecord(item.wallet, item.prId);
            }

            const receipt = await tx.wait();
            item.status = "COMPLETED";
            item.txHash = receipt.hash;
            console.log(`✨ Tx Confirmed: ${receipt.hash}`);
        } catch (error) {
            console.error(`❌ Blockchain Error:`, error.message);
            item.status = "FAILED";
        }
    }
    writeDB(db);
}

setInterval(processQueue, 15000); // Check every 15 seconds

app.get("/", (req, res) => res.send("🚀 DevTrust Backend is Live"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
