// server-simple.js - Enhanced Connection Version
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const https = require('https');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ตัวแปรเก็บข้อมูล
let latestQueueData = null;
let counterHistory = {};
let isConnected = false;
let mockDataInterval = null;
let connectionRetries = 0;
const MAX_RETRIES = 5;

// กำหนด URL ของระบบคิว
const QUEUE_URL = 'https://elands.dol.go.th/QueueOnlineServer/queue/294';
const STREAM_URL = 'https://elands.dol.go.th/QueueOnlineServer/service/queue_stream/294';

// Enhanced Headers สำหรับหลอกให้เหมือนเบราว์เซอร์จริง
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/event-stream,text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity', // ไม่ใช้ compression เพื่อป้องกันปัญหา
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
};

// สร้าง HTTPS Agent แบบกำหนดเอง
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10,
    timeout: 30000,
    // ผ่อนปรน SSL สำหรับเซิร์ฟเวอร์ที่มีปัญหา
    rejectUnauthorized: false,
    secureProtocol: 'TLSv1_2_method'
});

// ฟังก์ชันสร้างข้อมูลจำลองแบบเรียลไทม์
let mockCurrentQueue = 2010;
let mockWaitingQueues = [];

function initializeMockData() {
    mockWaitingQueues = [];
    for (let i = 1; i <= 8; i++) {
        mockWaitingQueues.push({
            queueNo: String(mockCurrentQueue + i).padStart(4, '0'),
            customerName: `ลูกค้า ${i}`,
            serviceType: 'บริการทั่วไป',
            timeWaiting: `${i * 2} นาที`
        });
    }
}

function updateMockData() {
    if (Math.random() > 0.4) {
        if (mockWaitingQueues.length > 0) {
            mockCurrentQueue = parseInt(mockWaitingQueues[0].queueNo);
            mockWaitingQueues.shift();
            
            const newQueueNo = mockCurrentQueue + mockWaitingQueues.length + 1;
            mockWaitingQueues.push({
                queueNo: String(newQueueNo).padStart(4, '0'),
                customerName: `ลูกค้า ${newQueueNo}`,
                serviceType: 'บริการทั่วไป',
                timeWaiting: '1 นาที'
            });
        }
    }
    
    return createMockData();
}

function createMockData() {
    const currentTime = new Date();
    const counterNo = Math.floor(Math.random() * 3) + 1;
    
    return {
        currentQueue: {
            queueNo: String(mockCurrentQueue).padStart(4, '0'),
            counterNo: String(counterNo),
            customerName: 'ลูกค้าปัจจุบัน',
            serviceType: 'บริการทั่วไป',
            startTime: currentTime.toLocaleTimeString('th-TH', { 
                hour: '2-digit', 
                minute: '2-digit' 
            })
        },
        queue: mockWaitingQueues,
        totalWaiting: mockWaitingQueues.length,
        lastUpdated: currentTime.toLocaleTimeString('th-TH'),
        fetchedAt: currentTime.toISOString(),
        source: 'mock_data_realtime',
        serverTime: currentTime.toLocaleString('th-TH'),
        status: 'มีการให้บริการ'
    };
}

// ฟังก์ชันเชื่อมต่อ SSE แบบ Enhanced
function connectToSSE() {
    return new Promise((resolve, reject) => {
        connectionRetries++;
        console.log(`🔗 เชื่อมต่อ SSE (ครั้งที่ ${connectionRetries}):`, STREAM_URL);
        
        const parsedUrl = url.parse(STREAM_URL);
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.path,
            method: 'GET',
            headers: {
                ...BROWSER_HEADERS,
                'Accept': 'text/event-stream',
                'Host': parsedUrl.hostname
            },
            agent: httpsAgent,
            timeout: 20000
        };

        console.log('🔧 Connection Options:', {
            hostname: options.hostname,
            path: options.path,
            userAgent: options.headers['User-Agent'].substring(0, 50) + '...',
            timeout: options.timeout
        });

        const sseRequest = https.request(options, (res) => {
            console.log('📡 SSE Response:', {
                statusCode: res.statusCode,
                headers: {
                    'content-type': res.headers['content-type'],
                    'server': res.headers['server'],
                    'connection': res.headers['connection']
                }
            });
            
            if (res.statusCode !== 200) {
                console.error(`❌ HTTP Error: ${res.statusCode} ${res.statusMessage}`);
                reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                return;
            }

            isConnected = true;
            connectionRetries = 0; // รีเซ็ตเมื่อเชื่อมต่อสำเร็จ
            console.log('✅ SSE Connected Successfully!');
            resolve();

            let buffer = '';
            let dataReceived = false;

            res.on('data', (chunk) => {
                dataReceived = true;
                buffer += chunk.toString();
                
                const lines = buffer.split('\n');
                buffer = lines.pop();

                lines.forEach(line => {
                    console.log('📨 SSE Line:', line.substring(0, 100) + (line.length > 100 ? '...' : ''));
                    
                    if (line.startsWith('data:')) {
                        try {
                            const jsonStr = line.substring(5).trim();
                            if (jsonStr && jsonStr !== '') {
                                const sseData = JSON.parse(jsonStr);
                                
                                console.log('📦 SSE Data Keys:', Object.keys(sseData));
                                
                                if (sseData.manageListQueue) {
                                    const queueData = JSON.parse(sseData.manageListQueue);
                                    
                                    latestQueueData = {
                                        ...queueData,
                                        fetchedAt: new Date().toISOString(),
                                        source: 'sse_stream'
                                    };
                                    
                                    updateCounterHistory(latestQueueData);
                                    
                                    console.log('✅ Queue Data Updated from SSE:', {
                                        currentQueue: latestQueueData.currentQueue?.queueNo,
                                        counter: latestQueueData.currentQueue?.counterNo,
                                        waitingQueues: latestQueueData.queue?.length || 0,
                                        source: latestQueueData.source
                                    });
                                }
                            }
                        } catch (parseError) {
                            console.error('❌ JSON Parse Error:', parseError.message);
                            console.error('❌ Raw Data:', line.substring(0, 200));
                        }
                    }
                });
            });

            res.on('end', () => {
                console.log('📡 SSE Connection ended gracefully');
                isConnected = false;
                // อย่า reconnect ทันที ให้รอ
            });

            res.on('error', (error) => {
                console.error('❌ SSE Stream Error:', error.message);
                isConnected = false;
            });

            // ตรวจสอบว่ามีข้อมูลมาหรือไม่
            setTimeout(() => {
                if (!dataReceived) {
                    console.log('⚠️ No data received after 30 seconds, considering connection as failed');
                    res.destroy();
                    isConnected = false;
                    reject(new Error('No data received'));
                }
            }, 30000);
        });

        sseRequest.on('error', (error) => {
            console.error('❌ SSE Request Error:', {
                message: error.message,
                code: error.code,
                errno: error.errno,
                syscall: error.syscall,
                hostname: error.hostname
            });
            isConnected = false;
            reject(error);
        });

        sseRequest.setTimeout(20000, () => {
            console.log('⏰ SSE Request Timeout (20 seconds)');
            sseRequest.destroy();
            isConnected = false;
            reject(new Error('SSE Request Timeout'));
        });

        sseRequest.end();
    });
}

// ฟังก์ชันดึงข้อมูลแบบ HTTP fallback แบบ Enhanced
async function fetchQueueDataHTTP() {
    try {
        console.log('🔗 HTTP Fallback with Enhanced Headers');
        
        const response = await axios.get(QUEUE_URL, {
            headers: BROWSER_HEADERS,
            timeout: 15000,
            httpsAgent: httpsAgent,
            validateStatus: function (status) {
                return status >= 200 && status < 300; // เฉพาะ 2xx
            },
            maxRedirects: 5,
            decompress: true
        });

        console.log('📡 HTTP Response:', {
            status: response.status,
            contentType: response.headers['content-type'],
            contentLength: response.headers['content-length'],
            server: response.headers['server']
        });

        const $ = cheerio.load(response.data);
        const scripts = $('script');
        
        let queueData = null;
        let scriptFound = false;
        
        scripts.each((index, element) => {
            const scriptContent = $(element).html();
            if (scriptContent && scriptContent.includes('queueOnlineDataFirst')) {
                scriptFound = true;
                console.log('📜 Found queue data script');
                
                const match = scriptContent.match(/var queueOnlineDataFirst = '(.+?)';/);
                if (match) {
                    try {
                        const jsonStr = match[1].replace(/&quot;/g, '"');
                        queueData = JSON.parse(jsonStr);
                        console.log('✅ Successfully parsed queue data from HTML');
                    } catch (parseError) {
                        console.error('❌ Parse Error:', parseError.message);
                        console.error('❌ Raw JSON (first 200 chars):', jsonStr.substring(0, 200));
                    }
                }
            }
        });

        if (!scriptFound) {
            console.log('⚠️ Queue data script not found in HTML');
            console.log('📄 HTML Content Preview:', response.data.substring(0, 500));
        }

        if (queueData) {
            latestQueueData = {
                ...queueData,
                fetchedAt: new Date().toISOString(),
                source: 'html_fallback'
            };
            
            updateCounterHistory(latestQueueData);
            console.log('✅ HTTP Fallback successful:', {
                currentQueue: latestQueueData.currentQueue?.queueNo,
                totalWaiting: latestQueueData.queue?.length || 0
            });
            return latestQueueData;
        } else {
            throw new Error('ไม่พบข้อมูลคิวในหน้าเว็บ');
        }

    } catch (error) {
        console.error('❌ HTTP Fallback Error:', {
            message: error.message,
            code: error.code,
            status: error.response?.status,
            statusText: error.response?.statusText
        });
        throw error;
    }
}

// อัพเดตประวัติช่องบริการ
function updateCounterHistory(queueData) {
    const currentQueue = queueData.currentQueue;
    if (!currentQueue) return;
    
    const counterNo = currentQueue.counterNo;
    const queueNo = currentQueue.queueNo;
    
    if (!counterHistory[counterNo]) {
        counterHistory[counterNo] = {
            current: null,
            completed: []
        };
    }
    
    const history = counterHistory[counterNo];
    
    if (history.current && history.current !== queueNo) {
        history.completed.unshift({
            queueNo: history.current,
            completedAt: new Date().toLocaleTimeString('th-TH')
        });
        
        if (history.completed.length > 3) {
            history.completed = history.completed.slice(0, 3);
        }
    }
    
    history.current = queueNo;
}

// เริ่มต้น Mock Data Mode
function startMockDataMode() {
    console.log('🔄 เริ่มใช้ Mock Data Mode (Real-time Simulation)');
    
    initializeMockData();
    latestQueueData = createMockData();
    updateCounterHistory(latestQueueData);
    
    if (mockDataInterval) {
        clearInterval(mockDataInterval);
    }
    
    mockDataInterval = setInterval(() => {
        latestQueueData = updateMockData();
        updateCounterHistory(latestQueueData);
        console.log('🔄 Mock Data Updated:', {
            currentQueue: latestQueueData.currentQueue?.queueNo,
            counter: latestQueueData.currentQueue?.counterNo,
            waitingQueues: latestQueueData.queue?.length || 0
        });
    }, 30000);
    
    console.log('✅ Mock Data Mode Started');
}

// API Routes
app.get('/api/queue-data', async (req, res) => {
    try {
        res.json({
            success: true,
            data: latestQueueData,
            counterHistory: counterHistory,
            connected: isConnected,
            timestamp: new Date().toISOString(),
            serverStatus: {
                mode: latestQueueData?.source || 'unknown',
                usingMockData: latestQueueData?.source?.includes('mock') || false,
                fallbackMode: !isConnected,
                lastUpdate: latestQueueData?.fetchedAt,
                connectionRetries: connectionRetries
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            connected: false
        });
    }
});

app.get('/api/counter-status', (req, res) => {
    res.json({
        success: true,
        counterHistory: counterHistory,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        status: {
            connected: isConnected,
            lastUpdate: latestQueueData?.fetchedAt || null,
            uptime: process.uptime(),
            counters: Object.keys(counterHistory).length,
            server: 'Queue Monitor v1.3 - Enhanced Connection',
            mode: latestQueueData?.source || 'starting',
            usingMockData: latestQueueData?.source?.includes('mock') || false,
            dataAvailable: !!latestQueueData,
            connectionRetries: connectionRetries,
            maxRetries: MAX_RETRIES
        }
    });
});

// Manual retry endpoint
app.get('/api/retry-connection', async (req, res) => {
    console.log('🔄 Manual connection retry requested');
    
    try {
        await connectToSSE();
        res.json({ success: true, message: 'SSE connection successful' });
    } catch (sseError) {
        try {
            await fetchQueueDataHTTP();
            res.json({ success: true, message: 'HTTP fallback successful' });
        } catch (httpError) {
            res.json({ 
                success: false, 
                message: 'Both SSE and HTTP failed', 
                errors: {
                    sse: sseError.message,
                    http: httpError.message
                }
            });
        }
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        connected: isConnected,
        hasData: !!latestQueueData,
        dataSource: latestQueueData?.source || 'none',
        connectionRetries: connectionRetries
    });
});

// เริ่มต้น server
async function startServer() {
    try {
        app.listen(PORT, () => {
            console.log('🚀 Server เริ่มทำงานแล้ว! (Enhanced Connection v1.3)');
            console.log(`📡 URL: http://localhost:${PORT}`);
            console.log(`🌐 Production URL จะได้รับจาก hosting provider`);
            console.log('');
            console.log('📋 API Endpoints:');
            console.log('  GET  /api/queue-data       - ดึงข้อมูลคิวและช่องบริการ');
            console.log('  GET  /api/retry-connection - ลองเชื่อมต่อใหม่');
            console.log('  GET  /api/status           - สถานะระบบ');
            console.log('  GET  /health               - Health check');
            console.log('');
            console.log('🔧 Enhanced Features:');
            console.log('  ✅ Enhanced Browser Headers');
            console.log('  ✅ Custom HTTPS Agent');
            console.log('  ✅ Better Error Handling');
            console.log('  ✅ Detailed Connection Logging');
        });
        
        // ลองเชื่อมต่อ SSE ก่อน
        console.log('🔍 Starting connection attempts...');
        
        const tryConnection = async () => {
            if (connectionRetries >= MAX_RETRIES) {
                console.log(`⚠️ Max retries (${MAX_RETRIES}) reached, switching to Mock Data`);
                startMockDataMode();
                return;
            }
            
            try {
                await connectToSSE();
                console.log('✅ SSE connection established!');
                
                // Monitor connection health
                setInterval(() => {
                    if (!isConnected) {
                        console.log('🔄 SSE disconnected, attempting reconnect...');
                        connectToSSE().catch(() => {
                            console.log('🔄 SSE reconnect failed, trying HTTP...');
                            fetchQueueDataHTTP().catch(() => {
                                console.log('🔄 HTTP failed, using mock data...');
                                if (!latestQueueData || latestQueueData.source !== 'mock_data_realtime') {
                                    startMockDataMode();
                                }
                            });
                        });
                    }
                }, 60000); // Check every minute
                
            } catch (sseError) {
                console.log('⚠️ SSE failed, trying HTTP fallback...');
                console.log('   SSE Error:', sseError.message);
                
                try {
                    await fetchQueueDataHTTP();
                    console.log('✅ HTTP fallback successful!');
                    
                    // Polling for HTTP mode
                    setInterval(async () => {
                        try {
                            await fetchQueueDataHTTP();
                        } catch (error) {
                            console.log('🔄 HTTP polling failed, using mock data...');
                            if (!latestQueueData || latestQueueData.source !== 'mock_data_realtime') {
                                startMockDataMode();
                            }
                        }
                    }, 20000); // Every 20 seconds
                    
                } catch (httpError) {
                    console.log('⚠️ HTTP fallback failed, retrying connection...');
                    console.log('   HTTP Error:', httpError.message);
                    
                    // Retry after delay
                    setTimeout(tryConnection, 30000);
                }
            }
        };
        
        await tryConnection();
        
    } catch (error) {
        console.error('❌ Server startup error:', error.message);
        process.exit(1);
    }
}

// เริ่มต้น
startServer();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 กำลังปิดเซิร์ฟเวอร์...');
    if (mockDataInterval) {
        clearInterval(mockDataInterval);
    }
    console.log('✅ ปิดระบบเรียบร้อย');
    process.exit(0);
});

module.exports = app;
