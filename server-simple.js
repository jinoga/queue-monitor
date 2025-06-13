// server-simple.js - With Cloudflare Workers Proxy
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
const MAX_RETRIES = 3; // ลดจำนวน retry

// กำหนด URL ของระบบคิว
const ORIGINAL_QUEUE_URL = 'https://elands.dol.go.th/QueueOnlineServer/queue/294';
const ORIGINAL_STREAM_URL = 'https://elands.dol.go.th/QueueOnlineServer/service/queue_stream/294';

// Cloudflare Workers Proxy URL - ให้ใส่ URL ของ Worker ที่สร้าง
const CLOUDFLARE_PROXY = process.env.CLOUDFLARE_PROXY || 'https://nskque.foryoukanade.workers.dev/'; // เปลี่ยนเป็น URL จริง

// สร้าง Proxied URLs
const QUEUE_URL = `${CLOUDFLARE_PROXY}?url=${encodeURIComponent(ORIGINAL_QUEUE_URL)}`;
const STREAM_URL = `${CLOUDFLARE_PROXY}?url=${encodeURIComponent(ORIGINAL_STREAM_URL)}`;

// Mock Data Functions (เหมือนเดิม)
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

// เชื่อมต่อ SSE ผ่าน Cloudflare Proxy
function connectToSSE() {
    return new Promise((resolve, reject) => {
        connectionRetries++;
        console.log(`🌐 เชื่อมต่อ SSE ผ่าน Cloudflare Proxy (ครั้งที่ ${connectionRetries})`);
        console.log(`📡 Proxy URL: ${STREAM_URL.substring(0, 100)}...`);
        
        const parsedUrl = url.parse(STREAM_URL);
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.path,
            method: 'GET',
            headers: {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Connection': 'keep-alive'
            },
            timeout: 30000 // เพิ่ม timeout สำหรับ proxy
        };

        const sseRequest = https.request(options, (res) => {
            console.log('📡 Proxy SSE Response:', {
                statusCode: res.statusCode,
                contentType: res.headers['content-type'],
                server: res.headers['server']
            });
            
            if (res.statusCode !== 200) {
                console.error(`❌ Proxy HTTP Error: ${res.statusCode} ${res.statusMessage}`);
                reject(new Error(`Proxy HTTP ${res.statusCode}: ${res.statusMessage}`));
                return;
            }

            isConnected = true;
            connectionRetries = 0;
            console.log('✅ SSE Connected via Proxy!');
            resolve();

            let buffer = '';
            let dataReceived = false;

            res.on('data', (chunk) => {
                dataReceived = true;
                buffer += chunk.toString();
                
                const lines = buffer.split('\n');
                buffer = lines.pop();

                lines.forEach(line => {
                    if (line.trim()) {
                        console.log('📨 Proxy SSE Line:', line.substring(0, 100) + (line.length > 100 ? '...' : ''));
                    }
                    
                    if (line.startsWith('data:')) {
                        try {
                            const jsonStr = line.substring(5).trim();
                            if (jsonStr && jsonStr !== '') {
                                const sseData = JSON.parse(jsonStr);
                                
                                console.log('📦 Proxy SSE Data Keys:', Object.keys(sseData));
                                
                                if (sseData.manageListQueue) {
                                    const queueData = JSON.parse(sseData.manageListQueue);
                                    
                                    latestQueueData = {
                                        ...queueData,
                                        fetchedAt: new Date().toISOString(),
                                        source: 'sse_stream_via_proxy'
                                    };
                                    
                                    updateCounterHistory(latestQueueData);
                                    
                                    console.log('✅ Queue Data Updated via Proxy:', {
                                        currentQueue: latestQueueData.currentQueue?.queueNo,
                                        counter: latestQueueData.currentQueue?.counterNo,
                                        waitingQueues: latestQueueData.queue?.length || 0,
                                        source: latestQueueData.source
                                    });
                                }
                            }
                        } catch (parseError) {
                            console.error('❌ Proxy JSON Parse Error:', parseError.message);
                            console.error('❌ Raw Data:', line.substring(0, 200));
                        }
                    }
                });
            });

            res.on('end', () => {
                console.log('📡 Proxy SSE Connection ended');
                isConnected = false;
            });

            res.on('error', (error) => {
                console.error('❌ Proxy SSE Stream Error:', error.message);
                isConnected = false;
            });

            // Check for data
            setTimeout(() => {
                if (!dataReceived) {
                    console.log('⚠️ No data received from proxy after 30 seconds');
                    res.destroy();
                    isConnected = false;
                    reject(new Error('No data received from proxy'));
                }
            }, 30000);
        });

        sseRequest.on('error', (error) => {
            console.error('❌ Proxy SSE Request Error:', {
                message: error.message,
                code: error.code
            });
            isConnected = false;
            reject(error);
        });

        sseRequest.setTimeout(30000, () => {
            console.log('⏰ Proxy SSE Request Timeout (30 seconds)');
            sseRequest.destroy();
            isConnected = false;
            reject(new Error('Proxy SSE Request Timeout'));
        });

        sseRequest.end();
    });
}

// HTTP Fallback ผ่าน Cloudflare Proxy
async function fetchQueueDataHTTP() {
    try {
        console.log('🌐 HTTP Fallback ผ่าน Cloudflare Proxy');
        console.log(`📡 Proxy URL: ${QUEUE_URL.substring(0, 100)}...`);
        
        const response = await axios.get(QUEUE_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
            },
            timeout: 20000
        });

        console.log('📡 Proxy HTTP Response:', {
            status: response.status,
            contentType: response.headers['content-type'],
            contentLength: response.headers['content-length']
        });

        const $ = cheerio.load(response.data);
        const scripts = $('script');
        
        let queueData = null;
        let scriptFound = false;
        
        scripts.each((index, element) => {
            const scriptContent = $(element).html();
            if (scriptContent && scriptContent.includes('queueOnlineDataFirst')) {
                scriptFound = true;
                console.log('📜 Found queue data script via proxy');
                
                const match = scriptContent.match(/var queueOnlineDataFirst = '(.+?)';/);
                if (match) {
                    try {
                        const jsonStr = match[1].replace(/&quot;/g, '"');
                        queueData = JSON.parse(jsonStr);
                        console.log('✅ Successfully parsed queue data via proxy');
                    } catch (parseError) {
                        console.error('❌ Parse Error:', parseError.message);
                    }
                }
            }
        });

        if (!scriptFound) {
            console.log('⚠️ Queue data script not found in proxied HTML');
        }

        if (queueData) {
            latestQueueData = {
                ...queueData,
                fetchedAt: new Date().toISOString(),
                source: 'html_fallback_via_proxy'
            };
            
            updateCounterHistory(latestQueueData);
            console.log('✅ HTTP Fallback via proxy successful:', {
                currentQueue: latestQueueData.currentQueue?.queueNo,
                totalWaiting: latestQueueData.queue?.length || 0
            });
            return latestQueueData;
        } else {
            throw new Error('ไม่พบข้อมูลคิวในหน้าเว็บ (via proxy)');
        }

    } catch (error) {
        console.error('❌ Proxy HTTP Fallback Error:', {
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
                usingProxy: latestQueueData?.source?.includes('proxy') || false,
                usingMockData: latestQueueData?.source?.includes('mock') || false,
                fallbackMode: !isConnected,
                lastUpdate: latestQueueData?.fetchedAt,
                connectionRetries: connectionRetries,
                proxyUrl: CLOUDFLARE_PROXY
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
            server: 'Queue Monitor v1.4 - Cloudflare Proxy',
            mode: latestQueueData?.source || 'starting',
            usingProxy: latestQueueData?.source?.includes('proxy') || false,
            usingMockData: latestQueueData?.source?.includes('mock') || false,
            dataAvailable: !!latestQueueData,
            connectionRetries: connectionRetries,
            maxRetries: MAX_RETRIES,
            proxyUrl: CLOUDFLARE_PROXY
        }
    });
});

// Manual retry endpoint
app.get('/api/retry-connection', async (req, res) => {
    console.log('🔄 Manual connection retry via proxy');
    
    try {
        await connectToSSE();
        res.json({ 
            success: true, 
            message: 'SSE connection via proxy successful',
            source: 'sse_stream_via_proxy'
        });
    } catch (sseError) {
        try {
            await fetchQueueDataHTTP();
            res.json({ 
                success: true, 
                message: 'HTTP fallback via proxy successful',
                source: 'html_fallback_via_proxy'
            });
        } catch (httpError) {
            res.json({ 
                success: false, 
                message: 'Both SSE and HTTP via proxy failed', 
                errors: {
                    sse: sseError.message,
                    http: httpError.message
                }
            });
        }
    }
});

// Proxy test endpoint
app.get('/api/test-proxy', async (req, res) => {
    try {
        const testResponse = await axios.get(CLOUDFLARE_PROXY, { timeout: 10000 });
        res.json({
            success: true,
            message: 'Proxy is working',
            proxyUrl: CLOUDFLARE_PROXY,
            status: testResponse.status
        });
    } catch (error) {
        res.json({
            success: false,
            message: 'Proxy test failed',
            proxyUrl: CLOUDFLARE_PROXY,
            error: error.message
        });
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
        usingProxy: true,
        proxyUrl: CLOUDFLARE_PROXY
    });
});

// เริ่มต้น server
async function startServer() {
    try {
        app.listen(PORT, () => {
            console.log('🚀 Server เริ่มทำงานแล้ว! (Cloudflare Proxy v1.4)');
            console.log(`📡 URL: http://localhost:${PORT}`);
            console.log(`🌐 Production URL จะได้รับจาก hosting provider`);
            console.log(`☁️ Cloudflare Proxy: ${CLOUDFLARE_PROXY}`);
            console.log('');
            console.log('📋 API Endpoints:');
            console.log('  GET  /api/queue-data       - ดึงข้อมูลคิวและช่องบริการ');
            console.log('  GET  /api/retry-connection - ลองเชื่อมต่อใหม่');
            console.log('  GET  /api/test-proxy       - ทดสอบ Proxy');
            console.log('  GET  /api/status           - สถานะระบบ');
            console.log('  GET  /health               - Health check');
        });
        
        // ตรวจสอบ Proxy ก่อน
        console.log('🔍 Testing Cloudflare Proxy...');
        try {
            const testResponse = await axios.get(CLOUDFLARE_PROXY, { timeout: 10000 });
            console.log('✅ Cloudflare Proxy is working:', testResponse.status);
        } catch (proxyError) {
            console.log('❌ Cloudflare Proxy test failed:', proxyError.message);
            console.log('⚠️ Please check your CLOUDFLARE_PROXY URL');
            console.log('   Current URL:', CLOUDFLARE_PROXY);
            console.log('   Switching to Mock Data Mode...');
            startMockDataMode();
            return;
        }
        
        // ลองเชื่อมต่อ SSE ผ่าน Proxy
        console.log('🔍 Attempting SSE connection via proxy...');
        
        const tryConnection = async () => {
            if (connectionRetries >= MAX_RETRIES) {
                console.log(`⚠️ Max retries (${MAX_RETRIES}) reached, switching to Mock Data`);
                startMockDataMode();
                return;
            }
            
            try {
                await connectToSSE();
                console.log('✅ SSE connection via proxy established!');
                
                // Monitor connection health
                setInterval(() => {
                    if (!isConnected) {
                        console.log('🔄 SSE disconnected, attempting reconnect via proxy...');
                        connectToSSE().catch(() => {
                            console.log('🔄 SSE reconnect failed, trying HTTP via proxy...');
                            fetchQueueDataHTTP().catch(() => {
                                console.log('🔄 HTTP failed, using mock data...');
                                if (!latestQueueData || latestQueueData.source !== 'mock_data_realtime') {
                                    startMockDataMode();
                                }
                            });
                        });
                    }
                }, 60000);
                
            } catch (sseError) {
                console.log('⚠️ SSE via proxy failed, trying HTTP fallback...');
                console.log('   SSE Error:', sseError.message);
                
                try {
                    await fetchQueueDataHTTP();
                    console.log('✅ HTTP fallback via proxy successful!');
                    
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
                    }, 30000);
                    
                } catch (httpError) {
                    console.log('⚠️ HTTP fallback via proxy failed, retrying...');
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
