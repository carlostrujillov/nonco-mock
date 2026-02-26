import { createServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, createHmac } from 'crypto';

const PORT = parseInt(process.env.PORT || '8787', 10);

// ─── Nonco upstream config (for real proxy path) ───────────────────────────
// Set these in Railway environment variables:
//   NONCO_API_KEY    → your Nonco API key
//   NONCO_API_SECRET → your Nonco API secret
//   NONCO_HOST       → noncouat.com (UAT) or noncotrading.com (PROD)
const NONCO_API_KEY    = process.env.NONCO_API_KEY    ?? '';
const NONCO_API_SECRET = process.env.NONCO_API_SECRET ?? '';
const NONCO_HOST       = process.env.NONCO_HOST       ?? 'noncouat.com';

// ─── HMAC auth helpers ──────────────────────────────────────────────────────
function noncoTs(): string {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
}

function buildAuthHeaders(apiKey: string, apiSecret: string, host: string) {
  const ts  = noncoTs();
  const msg = `GET\n${ts}\n${host}\n/ws/v1`;
  const sig = createHmac('sha256', apiSecret)
    .update(msg)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { ApiKey: apiKey, ApiTimestamp: ts, ApiSign: sig };
}

// ─── USD/MXN price feed ─────────────────────────────────────────────────────
let mid = 17.25;

async function fetchMid(): Promise<void> {
  try {
    const res  = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json() as any;
    const price = data?.rates?.MXN;
    if (price && typeof price === 'number') {
      mid = price;
      console.log(`[MID] USD/MXN = ${mid.toFixed(4)} (fetched from ExchangeRate-API)`);
    } else {
      console.log(`[MID] USD/MXN = ${mid.toFixed(4)} (cached — bad response)`);
    }
  } catch (err) {
    console.log(`[MID] USD/MXN = ${mid.toFixed(4)} (cached — fetch failed: ${err})`);
  }
}

fetchMid();
setInterval(fetchMid, 60_000);

function bid():   number { return +((mid - 0.015).toFixed(4)); }
function offer(): number { return +((mid + 0.015).toFixed(4)); }

function sessionId(): string {
  return Array.from({ length: 10 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]
  ).join('');
}

// ─── HTTP server ─────────────────────────────────────────────────────────────
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Nonco Railway Server OK\nRoutes:\n  /ws/v1        → mock\n  /proxy/ws/v1  → real Nonco proxy');
});

// ─── Mock WebSocket server (/ws/v1) ──────────────────────────────────────────
const mockWss = new WebSocketServer({ noServer: true });

mockWss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  console.log(`[MOCK] Client connected from ${req.socket.remoteAddress}`);
  const timers:   ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[]  = [];
  const activeRfqs = new Map<string, { cancelled: boolean }>();

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  send({ type: 'hello', ts: new Date().toISOString(), session_id: sessionId() });

  ws.on('message', (raw: Buffer | string) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'subscribe' && Array.isArray(msg.streams)) {
      for (const s of msg.streams) {
        const name: string = s.name;
        if (name === 'Security') {
          send({ reqid: msg.reqid, type: 'Security', data: [{ Symbol: 'USDT-MXN', BaseCurrency: 'USDT', QuoteCurrency: 'MXN', MinOrderQty: '100', MaxOrderQty: '1000000', QtyIncrement: '0.01', MinQuoteQty: '1000', MaxQuoteQty: '20000000', QuoteQtyIncrement: '0.01', PriceIncrement: '0.0001', Status: 'Open' }] });
        } else if (name === 'Balance') {
          send({ reqid: msg.reqid, type: 'Balance', data: [{ Currency: 'MXN', Available: '5000000', Total: '5000000' }, { Currency: 'USDT', Available: '250000', Total: '250000' }] });
        } else if (name === 'MarketDataSnapshot') {
          send({ reqid: msg.reqid, type: 'MarketDataSnapshot', data: [{ Symbol: 'USDT-MXN', BidPx: bid().toString(), OfferPx: offer().toString(), BidSize: '50000', OfferSize: '50000', Timestamp: new Date().toISOString() }] });
          const t = setInterval(() => {
            send({ type: 'MarketDataSnapshot', data: [{ Symbol: 'USDT-MXN', BidPx: bid().toString(), OfferPx: offer().toString(), BidSize: '50000', OfferSize: '50000', Timestamp: new Date().toISOString() }] });
          }, 1000);
          timers.push(t);
        } else {
          send({ reqid: msg.reqid, type: name, data: [] });
        }
      }
      return;
    }

    if (msg.type === 'QuoteRequest' && Array.isArray(msg.data)) {
      for (const item of msg.data) {
        const quoteReqId: string = item.QuoteReqID;
        const rfqId    = randomUUID();
        const orderQty = item.OrderQty || '10000';
        const symbol   = item.Symbol   || 'USDT-MXN';
        const expiresAt = new Date(Date.now() + 15_000);
        console.log(`[MOCK][RFQ] QuoteReqID=${quoteReqId} qty=${orderQty}`);
        const rfqState = { cancelled: false };
        activeRfqs.set(quoteReqId, rfqState);
        const makeQuote = (status: string) => ({ type: 'Quote', data: [{ RFQID: rfqId, QuoteReqID: quoteReqId, QuoteID: randomUUID(), QuoteStatus: status, Symbol: symbol, Currency: 'USDT', OrderQty: orderQty, BidPx: bid().toString(), BidAmt: (bid() * parseFloat(orderQty)).toFixed(2), OfferPx: offer().toString(), OfferAmt: (offer() * parseFloat(orderQty)).toFixed(2), AmountCurrency: 'MXN', ValidUntilTime: new Date(Date.now() + 10_000).toISOString(), EndTime: expiresAt.toISOString(), Timestamp: new Date().toISOString(), SubmitTime: new Date().toISOString() }] });
        send(makeQuote('PendingNew'));
        const t1 = setTimeout(() => {
          if (rfqState.cancelled) return;
          send(makeQuote('Open'));
          const refresh = setInterval(() => {
            if (rfqState.cancelled || Date.now() >= expiresAt.getTime()) {
              clearInterval(refresh);
              if (!rfqState.cancelled) { send(makeQuote('Canceled')); activeRfqs.delete(quoteReqId); }
              return;
            }
            send(makeQuote('Open'));
          }, 9999);
          timers.push(refresh);
        }, 150);
        timeouts.push(t1);
      }
      return;
    }

    if (msg.type === 'NewOrderSingle' && Array.isArray(msg.data)) {
      for (const item of msg.data) {
        const orderId   = randomUUID();
        const clOrdId   = item.ClOrdID;
        const side      = item.Side;
        const qty       = item.OrderQty || '10000';
        const symbol    = item.Symbol   || 'USDT-MXN';
        const rfqId     = item.RFQID;
        const quoteId   = item.QuoteID;
        const fillPrice = side === 'Sell' ? bid() : offer();
        console.log(`[MOCK][ORDER] ClOrdID=${clOrdId} Side=${side} Qty=${qty} Px=${fillPrice}`);
        const makeExec = (execType: string, ordStatus: string, extra: object = {}) => ({ type: 'ExecutionReport', data: [{ OrderID: orderId, ClOrdID: clOrdId, ExecType: execType, OrdStatus: ordStatus, Symbol: symbol, Side: side, OrderQty: qty, CumQty: '0', AvgPx: '0', RFQID: rfqId, QuoteID: quoteId, Timestamp: new Date().toISOString(), ...extra }] });
        send(makeExec('PendingNew', 'PendingNew'));
        const t1 = setTimeout(() => { send(makeExec('New', 'New')); }, 100);
        const t2 = setTimeout(() => {
          const lastAmt = (parseFloat(qty) * fillPrice).toFixed(2);
          send(makeExec('Trade', 'Filled', { CumQty: qty, AvgPx: fillPrice.toString(), LastPx: fillPrice.toString(), LastQty: qty, LastAmt: lastAmt }));
          send({ type: 'Trade', data: [{ TradeID: randomUUID(), OrderID: orderId, ClOrdID: clOrdId, Symbol: symbol, Side: side, LastPx: fillPrice.toString(), LastQty: qty, LastAmt: lastAmt, Timestamp: new Date().toISOString() }] });
          send({ type: 'Quote', data: [{ RFQID: rfqId, QuoteReqID: '', QuoteID: quoteId, QuoteStatus: 'Filled', Symbol: symbol, Currency: 'USDT', OrderQty: qty, BidPx: bid().toString(), BidAmt: (bid() * parseFloat(qty)).toFixed(2), OfferPx: offer().toString(), OfferAmt: (offer() * parseFloat(qty)).toFixed(2), AmountCurrency: 'MXN', ValidUntilTime: new Date().toISOString(), EndTime: new Date().toISOString(), Timestamp: new Date().toISOString(), SubmitTime: new Date().toISOString() }] });
          console.log(`[MOCK][FILL] OrderID=${orderId} Side=${side} Qty=${qty} Px=${fillPrice}`);
        }, 400);
        timeouts.push(t1, t2);
      }
      return;
    }

    if (msg.type === 'QuoteCancelRequest' && Array.isArray(msg.data)) {
      for (const item of msg.data) {
        const quoteReqId = item.QuoteReqID;
        const rfqId      = item.RFQID;
        const state      = activeRfqs.get(quoteReqId);
        if (state) { state.cancelled = true; activeRfqs.delete(quoteReqId); }
        send({ type: 'Quote', data: [{ RFQID: rfqId, QuoteReqID: quoteReqId, QuoteID: randomUUID(), QuoteStatus: 'Canceled', Symbol: 'USDT-MXN', Currency: 'USDT', OrderQty: '0', BidPx: '0', BidAmt: '0', OfferPx: '0', OfferAmt: '0', AmountCurrency: 'MXN', ValidUntilTime: new Date().toISOString(), EndTime: new Date().toISOString(), Timestamp: new Date().toISOString(), SubmitTime: new Date().toISOString() }] });
        console.log(`[MOCK][CANCEL] QuoteReqID=${quoteReqId}`);
      }
      return;
    }
  });

  ws.on('close', () => {
    console.log('[MOCK] Client disconnected');
    timers.forEach(clearInterval);
    timeouts.forEach(clearTimeout);
  });
});

// ─── Proxy WebSocket server (/proxy/ws/v1) ───────────────────────────────────
const proxyWss = new WebSocketServer({ noServer: true });

proxyWss.on('connection', (browser: WebSocket, req: IncomingMessage) => {
  console.log(`[PROXY] Client connected from ${req.socket.remoteAddress}`);

  // Read per-connection LP overrides from query string (for multi-LP support)
// DESPUÉS (correcto):
const lpId      = (urlParams.get('lp_id') ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
const apiKey    = process.env[`NONCO_API_KEY_${lpId}`]    || NONCO_API_KEY    || '';
const apiSecret = process.env[`NONCO_API_SECRET_${lpId}`] || NONCO_API_SECRET || '';
const host      = process.env[`NONCO_HOST_${lpId}`]       || NONCO_HOST       || 'noncouat.com';

  if (!apiKey || !apiSecret) {
    console.error('[PROXY] Missing credentials — closing connection');
    browser.close(1008, 'Missing LP credentials');
    return;
  }

  const headers    = buildAuthHeaders(apiKey, apiSecret, host);
  const upstreamUrl = `wss://${host}/ws/v1`;

  console.log(`[PROXY] Connecting to upstream: ${upstreamUrl}`);
  console.log(`[PROXY] ApiKey=${headers.ApiKey} Timestamp=${headers.ApiTimestamp}`);

  const upstream = new WebSocket(upstreamUrl, [], {
    headers: {
      'ApiKey':       headers.ApiKey,
      'ApiTimestamp': headers.ApiTimestamp,
      'ApiSign':      headers.ApiSign,
    },
  });

  upstream.on('open', () => {
    console.log(`[PROXY] Upstream open`);
    browser.send(JSON.stringify({ type: 'proxy_connected', host }));
  });

  upstream.on('message', (data) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(data);
  });

  upstream.on('close', (code, reason) => {
    console.log(`[PROXY] Upstream closed: ${code} ${reason}`);
const safeCode = (code >= 1000 && code <= 4999) ? code : 1001;
if (browser.readyState === WebSocket.OPEN) browser.close(safeCode, reason.toString());
  });

  upstream.on('error', (err) => {
    console.error(`[PROXY] Upstream error:`, err.message);
    if (browser.readyState === WebSocket.OPEN)
      browser.send(JSON.stringify({ type: 'proxy_error', error: err.message }));
  });

  browser.on('message', (data) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
  });

  browser.on('close', () => {
    console.log('[PROXY] Browser disconnected');
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'Browser disconnected');
  });
});

// ─── Route upgrade requests by path ─────────────────────────────────────────
server.on('upgrade', (req: IncomingMessage, socket, head) => {
  const path = req.url?.split('?')[0];

  if (path === '/ws/v1') {
    mockWss.handleUpgrade(req, socket, head, (ws) => {
      mockWss.emit('connection', ws, req);
    });
  } else if (path === '/proxy/ws/v1') {
    proxyWss.handleUpgrade(req, socket, head, (ws) => {
      proxyWss.emit('connection', ws, req);
    });
  } else {
    console.log(`[ROUTE] Unknown path: ${path} — closing`);
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT}`);
  console.log(`[SERVER] Mock:  ws://localhost:${PORT}/ws/v1`);
  console.log(`[SERVER] Proxy: ws://localhost:${PORT}/proxy/ws/v1`);
  console.log(`[SERVER] Nonco host: ${NONCO_HOST}`);
});
