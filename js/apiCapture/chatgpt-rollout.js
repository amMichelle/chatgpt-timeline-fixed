// 2026-09 灰度接口兼容层（MAIN world）。删除本文件及 manifest 引用即可只保留旧接口。
// 页面自身请求到的 messages 只作为局部缓存；完整时间轴由 chatgpt.js
// 主动遍历游标分页并按“旧页在前、新页在后”合并后才标记为 complete。
window.AITChatGPTRolloutAPI = {
  match(pathname) {
    return pathname.match(/^\/backend-api\/conversations\/([0-9a-f][0-9a-f-]{18,})$/i);
  },
  nodes(json) {
    if (!Array.isArray(json?.messages)) return null;
    return json.messages.map(message => ({ id: message?.id, message }));
  }
};
