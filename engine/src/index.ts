import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";
import { BALANCES, FILLS, ORDERBOOKS, ORDERS, type CreateOrderInput, type Fill, type OrderBook, type OrderRecord, type RestingOrder } from "./store/exchange-store.js";

export type EngineCommandType =
  | "create_order"
  | "get_depth"
  | "get_user_balance"
  | "get_order"
  | "cancel_order";

export interface EngineRequest {
  correlationId: string;
  responseQueue: string;
  type: EngineCommandType;
  payload: Record<string, unknown>;
}

type create_orderPayload = {
  userId: string,
  type: string,
  side: string,
  symbol: string,
  price: number | null
  qty: number
}

export interface EngineResponse {
  correlationId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error) => {
  console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect()]);

// :-)) I added this just to check the flow, remove it when you start
const DUMMY_SELL_ORDER = {
  orderId: "dummy-sell-order-1",
  userId: "dummy-seller",
  type: "limit",
  side: "sell",
  symbol: "BTC",
  price: 100,
  qty: 1,
  filledQty: 0,
  status: "open",
};

async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
  await responseClient.lPush(responseQueue, JSON.stringify(response));
}

function handleEngineRequest(message: EngineRequest): unknown {
  /**
   * TODO(student):
   * 1. Check _message.type.
   * 2. Read _message.payload.
   * 3. Call your order book / balance / order logic.
   * 4. Return the data that should go back to the backend.
   *
   * Required message types:
   * - create_order
   * - get_depth
   * - get_user_balance
   * - get_order
   * - cancel_order
   */

  if (message.type == "create_order") {
    const { userId, type, side, symbol, price, qty } = message.payload as unknown as CreateOrderInput



    let orderBook = ORDERBOOKS.get(symbol);
    if (!orderBook) {
      orderBook = {
        bids: new Map<number, RestingOrder[]>(),
        asks: new Map<number, RestingOrder[]>(),
      }
      ORDERBOOKS.set(symbol, orderBook)
    }
    const orderId = crypto.randomUUID();
    const createdAt = Date.now();
    const fills: Fill[] = []
    
    if (type === "market") {
      if (side === "buy") {
        const sortedAskPrices: number[] = [...orderBook.asks.keys()].sort((a, b) => a - b)
        if (sortedAskPrices.length == 0) {
          throw new Error("No liquidity Available")
        }
        if (!BALANCES.get(userId)) {
          BALANCES.set(userId, { usd: { available: 0, locked: 0 } })
        }
        
        let totalfilled = 0;
        let totalprice = 0;
        for (const levelPrice of sortedAskPrices) {
          let levelOrders = orderBook.asks.get(levelPrice)
          if (totalfilled >= qty) break;
          if ( !levelOrders ) {
            throw new Error("Order Not Found")
          }
          for (const restingOrder of levelOrders) {
            totalprice += restingOrder.qty * restingOrder.price
            let restOrderfilled = Math.min(restingOrder.qty - restingOrder.filledQty, qty - totalfilled);
            totalfilled += restOrderfilled;
            if (totalfilled >= qty) break;
          }
        }


        let userBalance = BALANCES.get(userId)
        let userUSD  = userBalance?.["USD"]?.available
        if (!userUSD || userUSD < totalprice) throw new Error("Insufficient Funds")
        
        userUSD = userUSD - totalprice
        
        
          // ek loop chalega jisme hum resting orders me filled qty badhaenge 
        // agar request ki qty us resting order se fullfil hui to ok nhi to hum next resting order me se qty fullfill krenge aur us resting order ki filled qty badhaenge
        // aur jab resting orders ki filled qty aur qty same huio to hum us resting order ko delete kr denge
        let qtyfilled = 0;
        let fills:Fill[] = []

        const now  = Date.now()
        for(const levelPrice of sortedAskPrices){
          let levelOrders = orderBook.asks.get(levelPrice)
          if(!levelOrders) throw new Error ("order not found")
          for( const restingOrder of levelOrders ){
            let restOrderfilled = Math.min(restingOrder.qty - restingOrder.filledQty, qty - qtyfilled )
             qtyfilled += restOrderfilled
            restingOrder.filledQty += restOrderfilled
            if(restingOrder.filledQty>0 && restingOrder.filledQty<restingOrder.qty){
              restingOrder.status = "partially_filled";
            } else if( restingOrder.filledQty == restingOrder.qty){
              restingOrder.status = "filled"
            }

            const fill : Fill = {
              fillId: crypto.randomUUID(),
              symbol,
              price:levelPrice,
              qty,
              buyOrderId: orderId,
              sellOrderId: restingOrder.orderId,
              createdAt: now
            } 
            fills.push(fill);
            FILLS.push(fill);


            if(qtyfilled==qty) break; 
          }
        }


                
        const order : OrderRecord = {
          orderId,
          userId,
          side,
          type:"market",
          symbol,
          price,
          qty,
          filledQty: qtyfilled,
          status:"partially_filled",
          fills,
          createdAt: now
        }


      }
    }
  }





// just checking the flow, remove this when you start implementing the logic
// if (message.type === "create_order") {
//   return {
//     orderId: crypto.randomUUID(),
//     status: "filled",
//     filledQty: DUMMY_SELL_ORDER.qty,
//     averagePrice: DUMMY_SELL_ORDER.price,
//     fills: [
//       {
//         fillId: crypto.randomUUID(),
//         symbol: DUMMY_SELL_ORDER.symbol,
//         price: DUMMY_SELL_ORDER.price,
//         qty: DUMMY_SELL_ORDER.qty,
//         buyOrderId: "request-buy-order",
//         sellOrderId: DUMMY_SELL_ORDER.orderId,
//       },
//     ],
//     note: "Smoke-test response only. Students must replace this with real matching logic.",
//   };
// }

if (message.type == "get_user_balance") {
  const { userId } = message.payload
  if (typeof userId !== "string") throw new Error("Invalid payload: missing userId")
  const balances = BALANCES.get(userId) ?? {}

  return { balances }
}

if (message.type == "get_order") {
  const { userId, orderId } = message.payload
  if (typeof orderId !== "string") throw new Error("Invalid payload: missing orderId")
  const order = ORDERS.get(orderId)
  if (!order) throw new Error("Order Not found")
  if (order.userId !== userId) throw new Error("Unauthorized")

  return { order }
}

if (message.type == "cancel_order") {
  const { userId, orderId } = message.payload


  if (typeof orderId != "string" || userId !== "string") throw new Error("Invalid payload: missing orderId or userId")

  const order = ORDERS.get(orderId)
  if (order?.userId !== userId) throw new Error("Unathorized");
  if (order.status === "filled") throw new Error("Cannot cancel filled order")
  if (order.status === "cancelled") throw new Error("order already cancelled")

  // resting order in limit type, so it need to remove from book

  const orderBook = ORDERBOOKS.get(order.symbol)
  if (orderBook) {
    const bookSide = order.side === "buy" ? orderBook.bids : orderBook.asks
    const level = order.price as number
    if (level != null) {
      const arr = bookSide.get(level) ?? [];
    }
  }






}


throw new Error("TODO(student): implement this engine request type");
}

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

for (; ;) {
  const item = await brokerClient.brPop(env.incomingQueue, 0);
  if (!item) continue;

  let message: EngineRequest;

  try {
    message = JSON.parse(item.element) as EngineRequest;
  } catch {
    console.error("Skipping invalid broker message");
    continue;
  }

  try {
    const data = handleEngineRequest(message);
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: true,
      data,
    });
  } catch (error) {
    await sendResponse(message.responseQueue, {
      correlationId: message.correlationId,
      ok: false,
      error: error instanceof Error ? error.message : "engine_error",
    });
  }
}