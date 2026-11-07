# Tapproved — Official Hackathon Demo Video Script

**Target Duration**: 2 minutes 30 seconds - 2 minutes 50 seconds  
**Tone**: Confident, energetic, visionary, technically precise  
**Screen Setup**: Split screen (Left: Screen recording of Dashboard / Terminal; Right: Webcam / Camera pointed at ESP32 device)

---

## Equipment & Screen Setup Checklist Before Recording

1. **Left Screen (Browser & Terminal)**:
   - Window 1: Dashboard open at `http://localhost:3000/dashboard`.
   - Window 2: Terminal open to `C:\Users\BTC\tapproved`.
   - Window 3: Browser tab open to NEAR Explorer for `manextech.testnet`.
2. **Right Camera (Physical Hardware)**:
   - ESP32-WROOM-32 connected via USB.
   - Physical button wired to GPIO25 clearly visible under good lighting.
3. **Audio**: Clean microphone, no background noise, confident pace (~130-140 words per minute).

---

## Master Scene-by-Scene Script

### Scene 1: The Hook & The Threat (0:00 - 0:35)

| Time | Visual / Video Track | Audio / Voiceover Track (What You Say) |
|---|---|---|
| **0:00 - 0:10** | **Face to camera** (or high-impact graphic showing AI Agent + Hot Wallet). | *"Autonomous AI agents will soon manage millions of dollars on NEAR. But giving an AI agent full custody of a hot wallet is financial suicide."* |
| **0:10 - 0:22** | **Graphic / Text on screen**: Prompt Injection $\rightarrow$ Drained Treasury. | *"A single prompt injection, a hallucinated transaction, or a compromised LLM context can wipe out your entire treasury in a single block."* |
| **0:22 - 0:35** | **Cut back to speaker**, holding up the ESP32 board. | *"Traditional solutions fail. Software 2FA can be phished. And forcing a human to approve every 10-cent micropayment destroys autonomy. We need a better way. This is **Tapproved**."* |

---

### Scene 2: The Core Innovation (0:35 - 1:00)

| Time | Visual / Video Track | Audio / Voiceover Track (What You Say) |
|---|---|---|
| **0:35 - 0:48** | **Show Architecture Diagram (from README)** or switch to Split-Screen (Dashboard on Left, ESP32 on Right). | *"Tapproved is a hardware-backed spending authorization system for autonomous AI agents on NEAR. It implements a smart, dual-tier spending model."* |
| **0:48 - 1:00** | **Highlight the Dashboard Quota Progress Bar**. | *"Routine payments under a configurable limit execute **100% autonomously** within strict daily quotas. But high-value, elevated payments are frozen on-chain until authorized by a physical human button press on dedicated hardware."* |

---

### Scene 3: Live Demo — Autonomous Routine Spending (1:00 - 1:35)

| Time | Visual / Video Track | Audio / Voiceover Track (What You Say) |
|---|---|---|
| **1:00 - 1:12** | **Split screen**: Terminal on left, Dashboard on right. Run `npm run agent:autonomous`. | *"Let’s see it live on NEAR Testnet. Here is an autonomous agent integrated with our official Tapproved TypeScript SDK."* |
| **1:12 - 1:25** | Terminal shows: `[Agent] Requesting 0.001 NEAR for API indexer fee...` $\rightarrow$ `Status: Approved (Autonomous)`. | *"The agent needs 0.001 NEAR to pay an API fee. It queries the treasury contract policy at `manextech.testnet`. Because 0.001 NEAR is below the soft limit, the contract checks the daily allowance and approves it automatically."* |
| **1:25 - 1:35** | Dashboard updates: Daily quota moves, payment settles as `paid`. | *"Zero human intervention. Zero friction. Total autonomy within safe mathematical boundaries."* |

---

### Scene 4: Live Demo — High-Value Physical Hardware Gating (1:35 - 2:15)

| Time | Visual / Video Track | Audio / Voiceover Track (What You Say) |
|---|---|---|
| **1:35 - 1:48** | Terminal triggers high-value spend (0.5 NEAR). **Dashboard flashes red alert**: `PENDING APPROVAL — Awaiting Physical Button Press`. | *"Now, watch what happens when the agent attempts a high-value payment of 0.5 NEAR. The smart contract immediately locks the payment in a `pending` state. The dashboard triggers a real-time countdown alert."* |
| **1:48 - 2:00** | **Camera zooms in on ESP32**. Finger presses the **GPIO25 physical button**. | *"The private signing key never touches the agent. It lives in the isolated memory of this ESP32 microcontroller. I press the physical button on GPIO25..."* |
| **2:00 - 2:15** | Serial logs signature $\rightarrow$ Dashboard flashes green: `SETTLED (Paid)` $\rightarrow$ Click NEAR Explorer transaction link. | *"...and the ESP32 computes an Ed25519 signature over the canonical payload. The NEAR contract verifies the signature on-chain and executes the payout. Here is the verified receipt right on NEAR Explorer!"* |

---

### Scene 5: Deep Engineering & Hackathon Alignment (2:15 - 2:40)

| Time | Visual / Video Track | Audio / Voiceover Track (What You Say) |
|---|---|---|
| **2:15 - 2:30** | **Quick screen tour of GitHub repo & CI matrix**: 100% green CI badges, Rust contract, C++ firmware, Node relay, typed SDK. | *"This isn’t a prototype mock. It’s a production-grade full-stack system: a Rust contract with NEP-297 events and state migration; C++ firmware with memory zeroization; a Node.js orchestration relay with idempotency locks; and a typed agent SDK."* |
| **2:30 - 2:40** | Show `docs/SECURITY-THREAT-MODEL.md`. | *"We wrote formal security threat models covering key theft, replay resistance, and storage headroom."* |

---

### Scene 6: The Vision & Closing (2:40 - 2:55)

| Time | Visual / Video Track | Audio / Voiceover Track (What You Say) |
|---|---|---|
| **2:40 - 2:55** | **Cut back to speaker** with ESP32 board in hand. Big smile, confident finish. | *"Autonomous agents are the future of the decentralized web, but only if humans retain physical control over their economic sovereignty. That is Tapproved: Autonomous speed. Physical security. Built on NEAR. Thank you!"* |

---

## Media Studio & Motion Graphics Kit

To record high-production-value visuals directly from your browser without complex video editing software:
1. **Launch the Tapproved Media Studio**: Start the relay (`npm start`) and open **`http://localhost:3000/dashboard/media-studio`** (or open `dashboard/media-studio.html` directly in Chrome).
2. **Motion Graphics Sequences**: Fullscreen broadcast animations for Scene 1 (AI Agent Hot Wallet dilemma), Scene 2 (Dual-tier architecture), Scene 3 (GPIO25 hardware pulse), and Scene 4 (Testnet verification). Use screen recording (OBS or QuickTime) while stepping through the scenes.
3. **1080p Thumbnail Generator**: Built-in 1920x1080 Canvas exporter with live customizable copy, brutalist typography, and 1-click PNG download. Pre-rendered high-res asset available at `docs/assets/tapproved-hackathon-thumbnail.jpg`.
4. **Broadcast Lower Thirds**: Transparent overlay cards with green-screen chroma-key toggle for introducing topics during screen recordings.

---

## Pro-Tips for Recording

1. **Energy is everything**: Speak with authority and enthusiasm. Smile when introducing the solution.
2. **Rehearse the button press**: Practice running the script once so you press the button smoothly at the 1:55 mark without fumbling.
3. **Sound quality**: If recording in a room with an echo, wear headphones with a mic close to your mouth.
4. **Thumbnail idea**: Split thumbnail — Left side: Red "HACKED / DRAINED", Right side: Green "TAPPROVED" with you holding the physical ESP32 device!
