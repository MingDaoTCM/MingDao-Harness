// 测试用"假密钥"工厂（v0.6.10，下游 PR #10 的同类问题）。
//
// 为什么要有它：公开仓库里 `sk-xxxx…`、`app-xxxx…` 这类**字面量**会被密钥扫描命中，
// 也会让读代码的人以为仓库里漏了真钥（下游就是这么先报了一次"密钥暴露"）。
// 而测试需要的只是"一个能被对应规则认出的字符串"——**运行时拼出来完全等价**，
// 源码里因此不再出现任何密钥形态的字面量。
//
// 用法：`fakeSecret('sk-')`、`fakeSecret('app-', 24)`、`fakeSecret('ghp_', 24)`。
/** @param {string} prefix @param {number} [len] */
export const fakeSecret = (prefix, len = 20) => prefix + 'x'.repeat(len);
