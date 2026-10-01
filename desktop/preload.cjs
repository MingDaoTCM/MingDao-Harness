// 桌面版 preload（v0.6.8）：向 WebUI 暴露**极小**的桌面能力面。
//
// 为什么需要：登记/添加工作空间的目录选择此前只能在网页里一层层点（还要先知道绝对路径），
// 桌面版完全可以弹**系统原生目录选择器**并默认停在用户家目录。
//
// 安全纪律（与整个项目一致）：
//   · 只暴露**一个**方法，不暴露 ipcRenderer 本体、不暴露 Node（渲染进程仍拿不到 require/fs）；
//   · 通道名写死，主进程侧对参数只当"起点目录"用，不做任何字符串拼接；
//   · sandbox: true + contextIsolation: true 不变——preload 只能碰 contextBridge/ipcRenderer。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__MDH_DESKTOP__', {
  /** 弹原生目录选择器；startDir 为空时停在当前系统用户的家目录。取消返回 null。 */
  pickDirectory: (startDir) => ipcRenderer.invoke('mdh:pick-directory', startDir || null),
  /** 供前端判断"我在桌面壳里"（浏览器里为 undefined，会自动回退到内置浏览弹窗） */
  isDesktop: true,
});
