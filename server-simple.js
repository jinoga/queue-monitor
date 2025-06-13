// server-simple.js - Fixed Version with Robust Fallback
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
let mockDataInterval = null;

// กำหนด URL ของระบบคิว
const QUEUE_URL = 'https://elands.dol.go.th/QueueOnlineServer/queue/294';
const STREAM_URL = 'https://elands.dol.go.th/QueueOnlineServer/service/queue_stream/294';

// ฟังก์ชันสร้างข้อมูลจำลองแบบเรียลไทม์
let mockCurrentQueue = 2010;
let mockWaitingQueues = [];

function initializeMockData() {
    // สร้างคิวเริ่มต้น
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
    // อัพเดตคิวปัจจุบัน (ทุก 30 วินาที)
    if (Math.random() > 0.4) { // 60% โอกาสที่จะเปลี่ยนคิว
        if (mockWaitingQueues.length > 0) {
            mockCurrentQueue = parseInt(mockWaitingQueues[0].queueNo);
            mockWaitingQueues.shift(); // ลบคิวแรก
            
            // เพิ่มคิวใหม่ท้ายสุด
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
    const counterNo = Math.floor(Math.random() * 3) + 1; // สุ่มช่อง 1-3
    
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

// ฟังก์ชันเชื่อมต่อ SSE (พร้อม fallback เร็ว)
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
                                
                                updateCounterHistory(latestQueueData);
                                
                                console.log('📊 Updated queue data from SSE:', {
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
            });

            res.on('error', (error) => {
                console.error('❌ SSE Error:', error.message);
                isConnected = false;
            });
        });

        sseRequest.on('error', (error) => {
            console.error('❌ Request Error:', error.message);
            isConnected = false;
            reject(error);
        });

        sseRequest.setTimeout(5000, () => { // ลด timeout เหลือ 5 วินาที
            console.log('⏰ SSE Timeout');
            sseRequest.destroy();
            isConnected = false;
            reject(new Error('SSE Timeout'));
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

// ฟังก์ชันดึงข้อมูลแบบ HTTP fallback (ลด timeout)
async function fetchQueueDataHTTP() {
    try {
        console.log('🔗 Fallback: ดึงข้อมูลจาก HTML page');
        
        const response = await axios.get(QUEUE_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 5000 // ลด timeout เหลือ 5 วินาที
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
        throw error;
    }
}

// เริ่มต้น Mock Data Mode
function startMockDataMode() {
    console.log('🔄 เริ่มใช้ Mock Data Mode (Real-time Simulation)');
    
    // Initialize mock data
    initializeMockData();
    latestQueueData = createMockData();
    updateCounterHistory(latestQueueData);
    
    // อัพเดต Mock Data ทุก 30 วินาที
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
    }, 30000); // ทุก 30 วินาที
    
    console.log('✅ Mock Data Mode เริ่มต้นเรียบร้อย');
}

// API Routes

// ดึงข้อมูลคิวปัจจุบัน
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
                lastUpdate: latestQueueData?.fetchedAt
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
            server: 'Queue Monitor v1.2 - Robust',
            mode: latestQueueData?.source || 'starting',
            usingMockData: latestQueueData?.source?.includes('mock') || false,
            dataAvailable: !!latestQueueData
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
        connected: isConnected,
        hasData: !!latestQueueData,
        dataSource: latestQueueData?.source || 'none'
    });
});

// Mock Data Control Endpoints
app.get('/api/toggle-mock', (req, res) => {
    if (mockDataInterval) {
        clearInterval(mockDataInterval);
        mockDataInterval = null;
        res.json({ success: true, message: 'Mock data stopped' });
    } else {
        startMockDataMode();
        res.json({ success: true, message: 'Mock data started' });
    }
});

// เริ่มต้น server
async function startServer() {
    try {
        app.listen(PORT, () => {
            console.log('🚀 Server เริ่มทำงานแล้ว! (Robust Version)');
            console.log(`📡 URL: http://localhost:${PORT}`);
            console.log(`🌐 Production URL จะได้รับจาก hosting provider`);
            console.log('');
            console.log('📋 API Endpoints:');
            console.log('  GET  /api/queue-data      - ดึงข้อมูลคิวและช่องบริการ');
            console.log('  GET  /api/counter-status  - สถานะช่องบริการ');
            console.log('  GET  /api/status          - สถานะระบบ');
            console.log('  GET  /api/toggle-mock     - เปิด/ปิด Mock Data');
            console.log('  GET  /health              - Health check');
        });
        
        // ลองเชื่อมต่อ SSE ก่อน (timeout เร็ว)
        console.log('🔍 ทดลองเชื่อมต่อ SSE...');
        try {
            await connectToSSE();
            console.log('✅ SSE connection สำเร็จ!');
            
            // Polling สำรอง ถ้า SSE ขาด
            setInterval(async () => {
                if (!isConnected) {
                    console.log('🔄 SSE disconnected, trying to reconnect...');
                    try {
                        await connectToSSE();
                    } catch (error) {
                        // ถ้าเชื่อมต่อไม่ได้ ให้ใช้ Mock Data
                        if (!latestQueueData || latestQueueData.source !== 'mock_data_realtime') {
                            startMockDataMode();
                        }
                    }
                }
            }, 60000); // ทุก 1 นาที
            
        } catch (sseError) {
            console.log('⚠️ SSE ล้มเหลว, ลองใช้ HTTP fallback...');
            
            try {
                await fetchQueueDataHTTP();
                console.log('✅ HTTP fallback สำเร็จ!');
                
                // Polling สำหรับ HTTP fallback
                setInterval(async () => {
                    try {
                        await fetchQueueDataHTTP();
                    } catch (error) {
                        console.log('⚠️ HTTP fallback ล้มเหลว, เปลี่ยนเป็น Mock Data');
                        if (!latestQueueData || latestQueueData.source !== 'mock_data_realtime') {
                            startMockDataMode();
                        }
                    }
                }, 15000); // ทุก 15 วินาที
                
            } catch (httpError) {
                console.log('⚠️ HTTP fallback ล้มเหลว, ใช้ Mock Data Mode');
                startMockDataMode();
            }
        }
        
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
    if (mockDataInterval) {
        clearInterval(mockDataInterval);
    }
    console.log('✅ ปิดระบบเรียบร้อย');
    process.exit(0);
});

module.exports = app;
