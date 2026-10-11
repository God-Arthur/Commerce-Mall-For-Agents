# 验证脚本留档

这两个脚本记录了 `docs/IMPLEMENTATION.md` 第二节那个发现的**可复现证据**：
McAfee 机制两种边界约定中，「人工上下界」变体并不 DSIC。

它们是**自包含**的（各自内嵌了一份机制实现），因此放在任何目录都能直接运行：

```bash
cd agent-market

# 变体 A vs 变体 B 的逐例对比
node docs/verification/variant-comparison.ts

# 变体 B 的大规模复核：DSIC / IR / 强预算平衡 / 效率损失
node docs/verification/variant-b-falsification.ts
```

## 预期输出

`variant-comparison.ts`：
```
变体A(人工上下界): 检验数=11000  违反=26
变体B(需k+1双方在册): 检验数=11000  违反=0
```

`variant-b-falsification.ts`：
```
网格{1..6} m,n<=3: 情形=1681 DSIC违反=0 IR违反=0 BB违反=0 效率损失>1=0 最大损失笔数=1
网格{0,1,2,3,4} 含0值 m,n<=3: ... 最大损失笔数=1
网格{1,2,2,3,3,4} 重价 m,n<=3: ... 最大损失笔数=1
网格{1..5} m,n<=4: ... 最大损失笔数=1
```

## 说明

生产代码在 `src/mechanism/mcafee.ts`。`test/dsic.test.ts` 会直接打那份生产代码，
而这两个脚本用的是内嵌副本 —— 因为它们需要**同时跑两个版本**做对照，
而生产代码只有被验证通过的那一个。