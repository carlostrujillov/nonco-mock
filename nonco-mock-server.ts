import { createServer, IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const PORT = parseInt(process.env.PORT || '8787', 10);

// --- Market simulation ---
let mid = 17.25;
const SPREAD = 0.04;
const CLAMP_LO = 16.50;
const CLAMP_HI = 18.00;

setInterval(() => {
  mid += (Math.random() - 0.5) * 0.003; // ±0.0015
  mid = Math.max(CLAMP_LO, Math.min(CLAMP_HI, mid));
}, 500);

function bid() { return +(mid - SPREAD / 2).toFixed(4); }
function offer() { return +(mid + SPREAD / 2).toFixed(4); }
function sessionId() { return Array.from({ length: 10 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]).join(''); }

// --- HTTP + WS setup ---
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Nonco Mock Server OK');
});

const wss = new WebSocketServer({ server, path: '/ws/v1' });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  console.log(`[CONN] Client connected from ${req.socket.remoteAddress}`);
  const timers: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];

  // Track active RFQs for cancellation
  const activeRfqs = new Map<string, { cancelled: boolean }>();

  const send = (msg: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // Hello
  send({ type: 'hello', ts: new Date().toISOString(), session_id: sessionId() });

  ws.on('message', (raw: Buffer | string) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // --- SUBSCRIBE ---
    if (msg.type === 'subscribe' && Array.isArray(msg.streams)) {
      for (const s of msg.streams) {
        const name: string = s.name;
        if (name === 'Security') {
          send({
            reqid: msg.reqid, type: 'Security', data: [{
              Symbol: 'USDT-MXN', BaseCurrency: 'USDT', QuoteCurrency: 'MXN',
              MinOrderQty: '100', MaxOrderQty: '1000000', QtyIncrement: '0.01',
              MinQuoteQty: '1000', MaxQuoteQty: '20000000', QuoteQtyIncrement: '0.01',
              PriceIncrement: '0.0001', Status: 'Open',
            }],
          });
        } else if (name === 'Balance') {
          send({
            reqid: msg.reqid, type: 'Balance', data: [
              { Currency: 'MXN', Available: '5000000', Total: '5000000' },
              { Currency: 'USDT', Available: '250000', Total: '250000' },
            ],
          });
        } else if (name === 'MarketDataSnapshot') {
          // Initial snapshot
          send({
            reqid: msg.reqid, type: 'MarketDataSnapshot', data: [{
              Symbol: 'USDT-MXN', BidPx: bid().toString(), OfferPx: offer().toString(),
              BidSize: '50000', OfferSize: '50000', Timestamp: new Date().toISOString(),
            }],
          });
          // Updates every 1s
          const t = setInterval(() => {
            send({
              type: 'MarketDataSnapshot', data: [{
                Symbol: 'USDT-MXN', BidPx: bid().toString(), OfferPx: offer().toString(),
                BidSize: '50000', OfferSize: '50000', Timestamp: new Date().toISOString(),
              }],
            });
          }, 1000);
          timers.push(t);
        } else {
          // Quote, ExecutionReport, Trade, Order → empty snapshot
          send({ reqid: msg.reqid, type: name, data: [] });
        }
      }
      return;
    }

    // --- QUOTEREQUEST ---
    if (msg.type === 'QuoteRequest' && Array.isArray(msg.data)) {
      for (const item of msg.data) {
        const quoteReqId: string = item.QuoteReqID;
        const rfqId = randomUUID();
        const orderQty = item.OrderQty || '10000';
        const symbol = item.Symbol || 'USDT-MXN';
        const expiresAt = new Date(Date.now() + 3 * 60 * 1000);

        console.log(`[RFQ] Received QuoteReqID=${quoteReqId} qty=${orderQty} symbol=${symbol}`);

        const rfqState = { cancelled: false };
        activeRfqs.set(quoteReqId, rfqState);

        const makeQuote = (status: string, extraFields: object = {}) => ({
          type: 'Quote',
          data: [{
            RFQID: rfqId,
            QuoteReqID: quoteReqId,
            QuoteID: randomUUID(),
            QuoteStatus: status,
            Symbol: symbol,
            Currency: 'USDT',
            OrderQty: orderQty,
            BidPx: bid().toString(),
            BidAmt: (bid() * parseFloat(orderQty)).toFixed(2),
            OfferPx: offer().toString(),
            OfferAmt: (offer() * parseFloat(orderQty)).toFixed(2),
            AmountCurrency: 'MXN',
            ValidUntilTime: new Date(Date.now() + 3000).toISOString(),
            EndTime: expiresAt.toISOString(),
            Timestamp: new Date().toISOString(),
            SubmitTime: new Date().toISOString(),
            ...extraFields,
          }],
        });

        // PendingNew immediately
        send(makeQuote('PendingNew'));

        // Open after 150ms
        const t1 = setTimeout(() => {
          if (rfqState.cancelled) return;
          send(makeQuote('Open'));

          // Refresh every 2s while open
          const refresh = setInterval(() => {
            if (rfqState.cancelled || Date.now() >= expiresAt.getTime()) {
              clearInterval(refresh);
              if (!rfqState.cancelled) {
                send(makeQuote('Canceled'));
                activeRfqs.delete(quoteReqId);
              }
              return;
            }
            send(makeQuote('Open'));
          }, 2000);
          timers.push(refresh);
        }, 150);
        timeouts.push(t1);
      }
      return;
    }

    // --- NEWORDERSINGLE (RFQ fill) ---
    if (msg.type === 'NewOrderSingle' && Array.isArray(msg.data)) {
      for (const item of msg.data) {
        const orderId = randomUUID();
        const clOrdId = item.ClOrdID;
        const side = item.Side;
        const qty = item.OrderQty || '10000';
        const symbol = item.Symbol || 'USDT-MXN';
        const fillPrice = side === 'Sell' ? bid() : offer();
        const rfqId = item.RFQID;
        const quoteId = item.QuoteID;

        console.log(`[ORDER] ClOrdID=${clOrdId} Side=${side} Qty=${qty} FillPx=${fillPrice}`);

        const makeExec = (execType: string, ordStatus: string, extra: object = {}) => ({
          type: 'ExecutionReport',
          data: [{
            OrderID: orderId, ClOrdID: clOrdId, ExecType: execType, OrdStatus: ordStatus,
            Symbol: symbol, Side: side, OrderQty: qty, CumQty: '0', AvgPx: '0',
            RFQID: rfqId, QuoteID: quoteId,
            Timestamp: new Date().toISOString(),
            ...extra,
          }],
        });

        // PendingNew
        send(makeExec('PendingNew', 'PendingNew'));

        // New after 100ms
        const t1 = setTimeout(() => {
          send(makeExec('New', 'New'));
        }, 100);
        timeouts.push(t1);

        // Trade after 400ms
        const t2 = setTimeout(() => {
          const lastAmt = (parseFloat(qty) * fillPrice).toFixed(2);
          send(makeExec('Trade', 'Filled', {
            CumQty: qty, AvgPx: fillPrice.toString(),
            LastPx: fillPrice.toString(), LastQty: qty, LastAmt: lastAmt,
          }));

          // Trade message
          send({
            type: 'Trade', data: [{
              TradeID: randomUUID(), OrderID: orderId, ClOrdID: clOrdId,
              Symbol: symbol, Side: side, LastPx: fillPrice.toString(),
              LastQty: qty, LastAmt: lastAmt, Timestamp: new Date().toISOString(),
            }],
          });

          // Quote → Filled
          send({
            type: 'Quote', data: [{
              RFQID: rfqId, QuoteReqID: '', QuoteID: quoteId,
              QuoteStatus: 'Filled', Symbol: symbol, Currency: 'USDT',
              OrderQty: qty, BidPx: bid().toString(),
              BidAmt: (bid() * parseFloat(qty)).toFixed(2),
              OfferPx: offer().toString(),
              OfferAmt: (offer() * parseFloat(qty)).toFixed(2),
              AmountCurrency: 'MXN',
              ValidUntilTime: new Date().toISOString(),
              EndTime: new Date().toISOString(),
              Timestamp: new Date().toISOString(),
              SubmitTime: new Date().toISOString(),
            }],
          });

          console.log(`[FILL] OrderID=${orderId} Side=${side} Qty=${qty} Px=${fillPrice}`);
        }, 400);
        timeouts.push(t2);
      }
      return;
    }

    // --- QUOTECANCELREQUEST ---
    if (msg.type === 'QuoteCancelRequest' && Array.isArray(msg.data)) {
      for (const item of msg.data) {
        const quoteReqId = item.QuoteReqID;
        const rfqId = item.RFQID;
        const state = activeRfqs.get(quoteReqId);
        if (state) {
          state.cancelled = true;
          activeRfqs.delete(quoteReqId);
        }
        send({
          type: 'Quote', data: [{
            RFQID: rfqId, QuoteReqID: quoteReqId, QuoteID: randomUUID(),
            QuoteStatus: 'Canceled', Symbol: 'USDT-MXN', Currency: 'USDT',
            OrderQty: '0', BidPx: '0', BidAmt: '0', OfferPx: '0', OfferAmt: '0',
            AmountCurrency: 'MXN',
            ValidUntilTime: new Date().toISOString(),
            EndTime: new Date().toISOString(),
            Timestamp: new Date().toISOString(),
            SubmitTime: new Date().toISOString(),
          }],
        });
        console.log(`[CANCEL] QuoteReqID=${quoteReqId}`);
      }
      return;
    }
  });

  ws.on('close', () => {
    console.log('[DISC] Client disconnected');
    timers.forEach(clearInterval);
    timeouts.forEach(clearTimeout);
  });
});

server.listen(PORT, () => {
  console.log(`[MOCK] Nonco mock server listening on port ${PORT}`);
  console.log(`[MOCK] WebSocket endpoint: ws://localhost:${PORT}/ws/v1`);
});
