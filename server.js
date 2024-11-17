const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const port = 8088;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Function to get auth URL from logs
async function getAuthUrl() {
    try {
        const logPath = '/root/.humanode/workspaces/default/tunnel/logs.txt';
        const logContent = await fs.readFile(logPath, 'utf8');
        
        // Find all WSS URLs in the log file
        const wssUrlRegex = /wss:\/\/\S+/g;
        const matches = logContent.match(wssUrlRegex);
        
        if (matches && matches.length > 0) {
            // Get the last URL
            const lastUrl = matches[matches.length - 1];
            // Remove wss:// prefix
            const extractedUrl = lastUrl.replace('wss://', '');
            // Construct final URL
            const finalUrl = `https://webapp.mainnet.stages.humanode.io/humanode/wss%3A%2F%2F${extractedUrl}`;
            return {
                success: true,
                url: finalUrl,
                raw_wss: lastUrl
            };
        } else {
            return {
                success: false,
                message: 'URL tunnel tidak ditemukan di logs.'
            };
        }
    } catch (error) {
        console.error('Error reading logs:', error);
        return {
            success: false,
            message: 'Error membaca file logs',
            error: error.message
        };
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Auth URL endpoint
app.get('/auth', async (req, res) => {
    try {
        const authUrlResult = await getAuthUrl();
        res.json(authUrlResult);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Internal Server Error',
            error: error.message
        });
    }
});

// Bioauth status endpoint
app.get('/cek', async (req, res) => {
    try {
        const [statusResponse, authUrlResult] = await Promise.all([
            axios.post('http://127.0.0.1:9933', {
                jsonrpc: '2.0',
                method: 'bioauth_status',
                params: [],
                id: 1
            }, {
                headers: {
                    'Content-Type': 'application/json'
                }
            }),
            getAuthUrl()
        ]);

        // Handle inactive status
        if (statusResponse.data.result === "Inactive") {
            res.json({
                status: {
                    result: "Inactive",
                    remaining_time: {
                        formatted: "Status Inactive - Silakan Autentikasi"
                    }
                },
                auth: authUrlResult
            });
            return;
        }

        // Calculate remaining time for active status
        const expiresAt = statusResponse.data.result.Active.expires_at;
        const now = Date.now();
        const remaining = expiresAt - now;
        
        const hours = Math.floor(remaining / (1000 * 60 * 60));
        const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

        res.json({
            status: {
                ...statusResponse.data,
                remaining_time: {
                    hours,
                    minutes,
                    formatted: `${hours} jam ${minutes} menit`
                }
            },
            auth: authUrlResult
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            success: false,
            message: 'Internal Server Error',
            error: error.message
        });
    }
});

// Web interface
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Bioauth Status</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 20px;
                    background-color: #f0f0f0;
                }
                .container {
                    background-color: white;
                    padding: 20px;
                    border-radius: 8px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    max-width: 800px;
                    margin: 0 auto;
                }
                .status-box {
                    margin: 10px 0;
                    padding: 15px;
                    border-radius: 4px;
                    background-color: #f8f9fa;
                }
                .auth-link {
                    word-break: break-all;
                    color: #0066cc;
                }
                .error {
                    color: red;
                }
                .refresh-btn {
                    background-color: #0066cc;
                    color: white;
                    border: none;
                    padding: 10px 20px;
                    border-radius: 4px;
                    cursor: pointer;
                }
                .refresh-btn:hover {
                    background-color: #0052a3;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Bioauth Status</h1>
                <button class="refresh-btn" onclick="refreshData()">Refresh</button>
                <div id="statusContent" class="status-box">Loading...</div>
            </div>

            <script>
                async function fetchData() {
                    try {
                        const response = await fetch('/cek');
                        const data = await response.json();
                        
                        let html = '<h2>Status</h2>';
                        
                        // Handle inactive status
                        if (data.status.result === "Inactive") {
                            html += '<p class="error">Status: INACTIVE</p>';
                        } else {
                            html += '<p>Sisa waktu: ' + data.status.remaining_time.formatted + '</p>';
                        }

                        // Add auth URL
                        if (data.auth.success) {
                            html += '<h2>Auth URL</h2>';
                            html += '<p>URL: <a href="' + data.auth.url + '" target="_blank" class="auth-link">' + 
                                  data.auth.url + '</a></p>';
                        } else {
                            html += '<p class="error">' + data.auth.message + '</p>';
                        }

                        document.getElementById('statusContent').innerHTML = html;
                    } catch (error) {
                        document.getElementById('statusContent').innerHTML = 
                            '<p class="error">Error: ' + error.message + '</p>';
                    }
                }

                function refreshData() {
                    document.getElementById('statusContent').innerHTML = 'Loading...';
                    fetchData();
                }

                // Initial fetch
                fetchData();
                // Refresh every 30 seconds
                setInterval(fetchData, 30000);
            </script>
        </body>
        </html>
    `);
});

// Start server
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});

// Handle process termination
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});