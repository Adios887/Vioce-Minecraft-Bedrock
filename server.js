/**
 * ==========================================================
 *  My Voice Chat - Backend server
 * ==========================================================
 * งานของไฟล์นี้มี 3 อย่าง:
 *
 * 1) เปิดช่องทาง WebSocket ที่พาธ  /mc
 *    -> นี่คือปลายทางที่ผู้เล่นใน Minecraft จะพิมพ์คำสั่งในเกม
 *       /connect ws://โดเมนของคุณ/mc
 *       (โดเมนของคุณ = ที่อยู่ที่ Render.com ให้มาหลัง deploy)
 *    เมื่อเกมต่อเข้ามา เซิร์ฟเวอร์จะ:
 *       - สร้างรหัสยืนยัน 6 หลัก
 *       - สั่งให้เกมพิมพ์รหัสนั้นในแชท (ผ่าน commandRequest)
 *       - subscribe event ตำแหน่งผู้เล่น (PlayerTravelled) และ
 *         ข้อความแชท (PlayerMessage)
 *
 * 2) เปิดช่องทาง WebSocket ที่พาธ  /site
 *    -> นี่คือปลายทางที่หน้าเว็บ (frontend/app.js) เชื่อมต่อเข้ามา
 *       ผู้เล่นกรอกรหัส 6 หลัก + ชื่อผู้เล่น เพื่อจับคู่กับ session
 *       ของ Minecraft ที่ตรงกัน จากนั้นข้อมูลสถานะไมค์/ตำแหน่ง/
 *       สัญญาณ WebRTC (สำหรับส่งเสียงจริงแบบ P2P ระหว่างเบราว์เซอร์)
 *       จะถูก "รีเลย์" ผ่านเซิร์ฟเวอร์นี้
 *
 * 3) เมื่อ Minecraft หลุดการเชื่อมต่อ (ปิดเกม / ลบโลก / ลบ add-on /
 *    server เอา add-on ออก) socket ที่พาธ /mc จะปิดตัวเองโดยอัตโนมัติ
 *    -> เซิร์ฟเวอร์จะแจ้งเตือนเว็บไซต์ทุกคนใน session นั้นว่า
 *       "disconnected" ให้ frontend ไปแสดง bubble แจ้งเตือนและ
 *       เคลียร์ข้อมูลการจับคู่ทิ้ง
 *
 * NOTE: ส่วนที่ยังเป็นแค่โครงเริ่มต้น (ดูคอมเมนต์ "TODO" ในไฟล์):
 *   - proximity ที่แม่นยำ (คำนวณจากตำแหน่งเทียบกับ dimension ด้วย)
 *   - SFU (เสียงผ่านเซิร์ฟเวอร์กลาง) ตอนนี้ทำแบบ P2P mesh เท่านั้น
 *     ซึ่งเหมาะกับกลุ่มเล็ก ๆ (ไม่กี่คน) ถ้าจะรองรับคนเยอะต้องทำ SFU
 *     เพิ่มภายหลัง (เช่นด้วย mediasoup)
 * ==========================================================
 */

const path = require("path");
const express = require("express");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const app = express();
app.use(express.static(path.join(__dirname, "..", "frontend")));

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`My Voice Chat backend กำลังทำงานที่พอร์ต ${process.env.PORT || 3000}`);
});

const wssMc = new WebSocketServer({ noServer: true });
const wssSite = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/mc")) {
    wssMc.handleUpgrade(req, socket, head, (ws) => wssMc.emit("connection", ws, req));
  } else if (req.url.startsWith("/site")) {
    wssSite.handleUpgrade(req, socket, head, (ws) => wssSite.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// sessions: key = รหัส 6 หลัก, value = { mcSocket, siteSockets: Map<playerName, ws>, positions: {} }
const sessions = new Map();

function genCode() {
  let code;
  do {
    code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  } while (sessions.has(code));
  return code;
}

function sendCommand(mcSocket, commandLine) {
  const requestId = crypto.randomUUID();
  mcSocket.send(
    JSON.stringify({
      header: { version: 1, requestId, messagePurpose: "commandRequest" },
      body: { version: 1, commandLine, origin: { type: "player" } },
    })
  );
}

function subscribeEvent(mcSocket, eventName) {
  mcSocket.send(
    JSON.stringify({
      header: { version: 1, requestId: crypto.randomUUID(), messagePurpose: "subscribe" },
      body: { eventName },
    })
  );
}

// ------------------------------------------------------------------
// การเชื่อมต่อจากฝั่ง Minecraft (/connect ws://.../mc)
// ------------------------------------------------------------------
wssMc.on("connection", (mcSocket) => {
  const code = genCode();
  const session = { mcSocket, siteSockets: new Map(), positions: {} };
  sessions.set(code, session);
  mcSocket.sessionCode = code;

  console.log(`[mc] เชื่อมต่อใหม่ -> รหัส ${code}`);

  subscribeEvent(mcSocket, "PlayerMessage");
  subscribeEvent(mcSocket, "PlayerTravelled");

  sendCommand(
    mcSocket,
    `tellraw @a {"rawtext":[{"text":"§b[MyVoiceChat] §fรหัสเชื่อมต่อเว็บไซต์ของคุณคือ: §e§l${code}"}]}`
  );

  mcSocket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const eventName = msg.body?.eventName;

    // ตำแหน่งผู้เล่น -> เก็บไว้เพื่อคำนวณ proximity แล้วส่งให้เว็บไซต์
    if (eventName === "PlayerTravelled") {
      const p = msg.body.player;
      if (p?.name) {
        session.positions[p.name] = {
          x: p.position?.x,
          y: p.position?.y,
          z: p.position?.z,
          dimension: msg.body.dimension,
        };
        broadcastToSite(session, { type: "positions", positions: session.positions });
      }
    }
  });

  mcSocket.on("close", () => {
    console.log(`[mc] หลุดการเชื่อมต่อ -> รหัส ${code}`);
    broadcastToSite(session, { type: "disconnected" });
    sessions.delete(code);
  });

  mcSocket.on("error", () => mcSocket.close());
});

// ------------------------------------------------------------------
// การเชื่อมต่อจากฝั่งเว็บไซต์
// ------------------------------------------------------------------
wssSite.on("connection", (siteSocket) => {
  siteSocket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ขั้นตอนยืนยันตัวตนด้วยรหัส 6 หลัก + ชื่อผู้เล่น
    if (msg.type === "verify") {
      const session = sessions.get(msg.code);
      if (!session) {
        siteSocket.send(JSON.stringify({ type: "verify_failed", reason: "รหัสไม่ถูกต้องหรือหมดอายุ" }));
        return;
      }
      siteSocket.sessionCode = msg.code;
      siteSocket.playerName = msg.playerName;
      session.siteSockets.set(msg.playerName, siteSocket);

      siteSocket.send(JSON.stringify({ type: "verified", playerName: msg.playerName }));

      // ตั้งสถานะเริ่มต้นเป็น "เชื่อมต่อแล้ว" (state 1)
      sendCommand(session.mcSocket, `scriptevent vcmc:status ${msg.playerName}|1`);

      // บอกทุกคนใน session ว่าตอนนี้มีใครอยู่บ้าง (ไว้เปิด WebRTC หากันเอง)
      broadcastPeerLists(session);
      return;
    }

    const session = sessions.get(siteSocket.sessionCode);
    if (!session) return;

    // ปิด/เปิดไมค์ -> อัปเดตไอคอนในเกม
    if (msg.type === "mute") {
      const state = msg.muted ? 2 : 1;
      sendCommand(session.mcSocket, `scriptevent vcmc:status ${siteSocket.playerName}|${state}`);
      return;
    }

    // กำลังพูดอยู่หรือไม่ (state 3 = พูดอยู่)
    if (msg.type === "talking" && !msg.muted) {
      const state = msg.talking ? 3 : 1;
      sendCommand(session.mcSocket, `scriptevent vcmc:status ${siteSocket.playerName}|${state}`);
      return;
    }

    // สัญญาณ WebRTC (offer/answer/ice) รีเลย์ไปหาผู้เล่นเป้าหมายใน session เดียวกัน
    if (msg.type === "signal") {
      const target = session.siteSockets.get(msg.to);
      if (target) {
        target.send(
          JSON.stringify({ type: "signal", from: siteSocket.playerName, data: msg.data })
        );
      }
      return;
    }
  });

  siteSocket.on("close", () => {
    const session = sessions.get(siteSocket.sessionCode);
    if (session && siteSocket.playerName) {
      session.siteSockets.delete(siteSocket.playerName);
      // แจ้งคนอื่นในกลุ่มว่ามีคนหลุด (ไว้เคลียร์ peer connection ฝั่งเขา)
      broadcastToSite(session, { type: "peer_left", playerName: siteSocket.playerName }, siteSocket);
    }
  });
});

function broadcastToSite(session, payload, exceptSocket) {
  for (const ws of session.siteSockets.values()) {
    if (ws !== exceptSocket && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }
}

// ส่งรายชื่อ "เพื่อนในกลุ่มเดียวกัน" ให้แต่ละคน (ไม่รวมตัวเอง)
// frontend ใช้รายชื่อนี้ในการเปิดการเชื่อมต่อ WebRTC หากันเอง (mesh)
function broadcastPeerLists(session) {
  const names = [...session.siteSockets.keys()];
  for (const [name, ws] of session.siteSockets.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify({ type: "peers", peers: names.filter((n) => n !== name) }));
  }
}

// heartbeat ระดับ TCP/WebSocket มาตรฐาน - ถ้าฝั่งใดหลุดจริง ๆ (ปิดเกม,
// เน็ตหลุด) socket จะปิดเองและ event "close" ด้านบนจะทำงานตาม
function heartbeat() {
  this.isAlive = true;
}
[wssMc, wssSite].forEach((wss) => {
  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", heartbeat);
  });
});
setInterval(() => {
  [wssMc, wssSite].forEach((wss) => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  });
}, 15000);
