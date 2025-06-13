// server-simple.js - Simplified Queue Monitor for Online Deployment
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

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

// กำหนด URL ของระบบคิว
const QUEUE_URL = 'https://elands.dol.go.th/QueueOnlineServer/queue/294';
const STREAM_URL = 'https://elands.dol.go.th/QueueOnlineServer/service/queue_stream/294';

// ฟังก์ชันเชื่อมต่อ SSE
function connectToSSE() {
    return new Promise((resolve, reject) => {
        console.log('🔗 เชื่อมต่อ SSE:', STREAM_URL);
        
        const https = require('https');
        const url = require('url');
        
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
            }
        };

        const sseRequest = https.request(options, (res) => {
            console.log('📡 SSE Connected, Status:', res.statusCode);
            
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            isConnected = true;
            resolve();

            let buffer = '';

            res.on('data', (chunk) => {
                buffer += chunk.toString();
                
                const lines = buffer.split('\n');
                buffer = lines.pop();

                lines.forEach(line => {
                    if (line.startsWith('data:')) {
                        try {
                            const jsonStr = line.substring(5);
                            const sseData = JSON.parse(jsonStr);
                            
                            if (sseData.manageListQueue) {
                                const queueData = JSON.parse(sseData.manageListQueue);
                                
                                latestQueueData = {
                                    ...queueData,
                                    fetchedAt: new Date().toISOString(),
                                    source: 'sse_stream'
                                };
                                
                                // อัพเดตประวัติช่องบริการ
                                updateCounterHistory(latestQueueData);
                                
                                console.log('📊 Updated queue data:', {
                                    currentQueue: latestQueueData.currentQueue?.queueNo,
                                    counter: latestQueueData.currentQueue?.counterNo,
                                    waitingQueues: latestQueueData.queue?.length || 0
                                });
                            }
                        } catch (parseError) {
                            console.error('❌ Parse Error:', parseError.message);
                        }
                    }
                });
            });

            res.on('end', () => {
                console.log('📡 SSE Connection ended');
                isConnected = false;
                setTimeout(() => connectToSSE().catch(console.error), 5000);
            });

            res.on('error', (error) => {
                console.error('❌ SSE Error:', error.message);
                isConnected = false;
                setTimeout(() => connectToSSE().catch(console.error), 5000);
            });
        });

        sseRequest.on('error', (error) => {
            console.error('❌ Request Error:', error.message);
            isConnected = false;
            reject(error);
        });

        sseRequest.setTimeout(30000, () => {
            console.log('⏰ SSE Timeout');
            sseRequest.destroy();
            isConnected = false;
            setTimeout(() => connectToSSE().catch(console.error), 5000);
        });

        sseRequest.end();
    });
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

// ฟังก์ชันดึงข้อมูลแบบ HTTP fallback
async function fetchQueueDataHTTP() {
    try {
        console.log('🔗 Fallback: ดึงข้อมูลจาก HTML page');
        
        const response = await axios.get(QUEUE_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const scripts = $('script');
        
        let queueData = null;
        
        scripts.each((index, element) => {
            const scriptContent = $(element).html();
            if (scriptContent && scriptContent.includes('queueOnlineDataFirst')) {
                const match = scriptContent.match(/var queueOnlineDataFirst = '(.+?)';/);
                if (match) {
                    try {
                        const jsonStr = match[1].replace(/&quot;/g, '"');
                        queueData = JSON.parse(jsonStr);
                    } catch (parseError) {
                        console.error('❌ Parse Error:', parseError.message);
                    }
                }
            }
        });

        if (queueData) {
            latestQueueData = {
                ...queueData,
                fetchedAt: new Date().toISOString(),
                source: 'html_fallback'
            };
            
            updateCounterHistory(latestQueueData);
            return latestQueueData;
        } else {
            throw new Error('ไม่พบข้อมูลในหน้าเว็บ');
        }

    } catch (error) {
        console.error('❌ HTTP Fallback Error:', error.message);
        return null;
    }
}

// API Routes

// ดึงข้อมูลคิวปัจจุบัน
app.get('/api/queue-data', async (req, res) => {
    try {
        let data = latestQueueData;
        
        if (!data) {
            data = await fetchQueueDataHTTP();
        }
        
        res.json({
            success: true,
            data: data,
            counterHistory: counterHistory,
            connected: isConnected,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            connected: false
        });
    }
});

// ดึงสถานะช่องบริการ
app.get('/api/counter-status', (req, res) => {
    res.json({
        success: true,
        counterHistory: counterHistory,
        timestamp: new Date().toISOString()
    });
});

// สถานะระบบ
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        status: {
            connected: isConnected,
            lastUpdate: latestQueueData?.fetchedAt || null,
            uptime: process.uptime(),
            counters: Object.keys(counterHistory).length,
            server: 'Queue Monitor v1.0'
        }
    });
});

// เสิร์ฟหน้าเว็บหลัก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// สำหรับ health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        connected: isConnected
    });
});

// เริ่มต้น server
async function startServer() {
    try {
        app.listen(PORT, () => {
            console.log('🚀 Server เริ่มทำงานแล้ว!');
            console.log(`📡 URL: http://localhost:${PORT}`);
            console.log(`🌐 Production URL จะได้รับจาก hosting provider`);
            console.log('');
            console.log('📋 API Endpoints:');
            console.log('  GET  /api/queue-data      - ดึงข้อมูลคิวและช่องบริการ');
            console.log('  GET  /api/counter-status  - สถานะช่องบริการ');
            console.log('  GET  /api/status          - สถานะระบบ');
            console.log('  GET  /health              - Health check');
        });
        
        // เริ่มต้น SSE connection
        console.log('🔍 เริ่มต้น SSE connection...');
        try {
            await connectToSSE();
            console.log('✅ SSE connection สำเร็จ!');
        } catch (error) {
            console.log('⚠️ SSE connection ล้มเหลว, ใช้ HTTP fallback');
            console.log('   Error:', error.message);
            await fetchQueueDataHTTP();
        }
        
        // Polling สำรอง
        setInterval(async () => {
            if (!isConnected) {
                await fetchQueueDataHTTP();
            }
        }, 10000); // ทุก 10 วินาที
        
    } catch (error) {
        console.error('❌ ข้อผิดพลาดในการเริ่มต้นเซิร์ฟเวอร์:', error.message);
        process.exit(1);
    }
}

// เริ่มต้น
startServer();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 กำลังปิดเซิร์ฟเวอร์...');
    console.log('✅ ปิดระบบเรียบร้อย');
    process.exit(0);
});

module.exports = app;