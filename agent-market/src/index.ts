/** 服务入口。 */
import { MarketEngine } from "./engine.ts";
import { createApp } from "./server.ts";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

const engine = new MarketEngine();
const server = createApp(engine);

server.listen(PORT, HOST, () => {
  console.log(`Agent 市场已启动`);
  console.log(`  地址     http://${HOST}:${PORT}`);
  console.log(`  健康检查 http://${HOST}:${PORT}/health`);
  console.log(`  机制     McAfee (1992) 占优策略双向拍卖（周期性出清）`);
  console.log(`  信息隔离 单 agent 报价私密，仅公开聚合结果`);
});

const shutdown = () => {
  console.log("\n正在关闭...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);