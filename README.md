# SMMTor Node.js REST API Gateway

A high-performance Node.js REST API Gateway for the **SMMTor** mobile application. This gateway acts as the bridge between the mobile app clients and the database/backend services, handling authentication, order processing, services, and payments.

---

## Features

- **Standardized REST API**: Endpoints served under `/api/v2`.
- **Backward-Compatible Legacy Translator**: Handles legacy SMM Panel query parameters/actions (e.g., `?action=login` or `?action=services`) and maps them internally to REST API endpoints.
- **Fail-Fast Database Shield**: Automatically verifies the database pool connection on startup and shuts down if the database is offline to prevent silent errors. Includes a dynamic offline shield middleware.
- **Automated Client Schema Migrations**: Auto-migrates database schemas (such as adding the `fcm_token` column to `clients`) at boot time.
- **Built-in Node.js Cron Engine**: Replaces traditional PHP `master_cron.php` background processes. Runs order status syncing, drip-feeds, auto-likes, refills, and payment updates asynchronously in the background.
- **Firebase Push Notifications**: Built-in Firebase Admin SDK integration for sending Firebase Cloud Messages (FCM). Fallbacks automatically to safe logging if credentials are not provided.
- **PM2 Clustering Support**: Out-of-the-box configurations for PM2 cluster mode scaling.
- **CloudLinux Passenger Optimized**: Includes `.htaccess` configuration for Passenger-based Node.js deployment on cPanel environments.
- **Winston logger**: Configured for request logging, error tracking, and custom log files.

---

## Prerequisites

- **Node.js**: `v20.x` or higher
- **Database**: MySQL 8.x
- **Push Notifications**: Firebase Project & Admin SDK Service Account JSON Key file

---

## Getting Started

### 1. Installation
Clone or upload the repository to your host and install the dependencies:
```bash
npm install
```

### 2. Environment Configuration
Create a `.env` file in the root directory by copying the `.env.example` template:
```bash
cp .env.example .env
```
Open `.env` and fill in the database credentials, site URLs, and configuration values:
```env
PORT=3000
NODE_ENV=production

DB_HOST=localhost
DB_PORT=3306
DB_USER=wintersm_winterpro
DB_PASS=your_mysql_password_here
DB_NAME=wintersm_winterpro
DB_CHARSET=utf8mb4

SITE_URL=https://smmtor.com
API_URL=https://api.smmtor.com
```

### 3. Firebase SDK Setup
1. Go to your **Firebase Console** -> **Project Settings** -> **Service Accounts**.
2. Click **Generate New Private Key** to download the JSON credentials file.
3. Rename the file to `firebase-key.json` and place it in the root folder of this project (next to `app.js`).
*(Note: If the key is missing, Firebase notifications will run in mock mode and print actions to the logs instead of throwing errors).*

---

## Running the Server

### Development Mode
Runs the application with hot reloading via `nodemon`:
```bash
npm run dev
```

### Production Mode
Starts the server normally:
```bash
npm start
```

### Running with PM2 (Recommended for Servers)
Runs the gateway in PM2 Cluster Mode using the `ecosystem.config.json` configuration file:
```bash
# Start the application
pm2 start ecosystem.config.json

# Save process list to persist across server restarts
pm2 save
```

---

## Deployment (cPanel / CloudLinux Passenger)
If you deploy this gateway on a cPanel environment using the CloudLinux Node.js web app manager, Passenger configurations are defined in the `.htaccess` file:

```htaccess
PassengerAppRoot "/home/wintersm/api.smmtor.com"
PassengerBaseURI "/"
PassengerNodejs "/home/wintersm/nodevenv/api.smmtor.com/20/bin/node"
PassengerAppType node
PassengerStartupFile app.js
```
Make sure `PassengerAppRoot` and `PassengerNodejs` reflect the correct paths configured in your cPanel dashboard.

---

## Folder Structure

```
├── config/              # Configuration (DB connection pools, winston logger)
├── controllers/         # REST Endpoint request handlers
├── data/                # Data structures and constants
├── logs/                # Application logs (app.log, error.log)
├── middlewares/         # Express middlewares (security, validation, error)
├── routes/              # Express API Route mappings (/api/v2)
├── services/            # Core business logic, Firebase push helper, PHP Bridge
│   └── cron/            # Node-based cron syncing tasks (orders, dripfeeds, refills)
├── .env                 # Secret environment variables (Excluded from git)
├── .gitignore           # Git ignore configurations (Only ignores node_modules)
├── app.js               # Application Entry Point & Server Boot script
├── auto_push.bat        # Interactive Git helper script (Add, Commit, Push, Pull)
├── ecosystem.config.json# PM2 Clustering config file
├── firebase-key.json    # Firebase Admin SDK Credentials
└── package.json         # Node.js dependencies and scripts
```

---

## Git Workflow Synchronization

A helper script `auto_push.bat` is available in the root directory. To run it:
```cmd
auto_push.bat
```
It provides a simple command-line interface to push/pull code changes and sync easily with the remote repository.
