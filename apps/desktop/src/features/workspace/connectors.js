const definitions=[
  {id:'weather',name:'天气',path:'M7 16a4 4 0 1 1 1-7 5 5 0 0 1 9 3 3 3 0 0 1 0 6H7M7 21l1-2m5 2 1-2m5 2 1-2',preview:'<div class="weather-preview"><strong>24<span>°</span></strong><div>多云<small>示例城市 · 19° / 26°</small></div></div><div class="weather-hours"><span>09:00<b>21°</b></span><span>12:00<b>24°</b></span><span>15:00<b>26°</b></span><span>18:00<b>23°</b></span></div>'},
  {id:'calendar',name:'日程',path:'M7 3v4m10-4v4M4 10h16M5 5h14v16H5V5m4 9h2m3 0h2m-7 4h2',preview:'<div class="agenda-row"><time>10:00</time><div>项目讨论<small>30 分钟 · 示例日程</small></div></div><div class="agenda-row"><time>14:30</time><div>专注时间<small>为重要的事情留白</small></div></div>'},
  {id:'mail',name:'邮件',path:'M3 5h18v14H3V5m0 0 9 7 9-7',preview:'<div class="mail-preview"><span class="mail-avatar">D</span><div><strong>Design Weekly</strong><small>本周设计灵感与阅读清单</small></div><i></i></div><p class="preview-excerpt">最新一期已准备好，看看值得收藏的三个想法。</p>'},
  {id:'obsidian',name:'笔记',path:'m12 3 7 5-2 11-8 2-4-9 7-9zm0 0 2 10-5 8m5-8 5-5',preview:'<div class="note-preview"><span>最近编辑</span><strong>灵感收集</strong><p>把零散的想法连接起来。</p><div><b># 想法</b><b># 工作</b></div></div>'},
  {id:'feeds',name:'订阅',path:'M5 4a15 15 0 0 1 15 15M5 10a9 9 0 0 1 9 9M5 17h2v2H5z',preview:'<div class="feed-preview"><span>阅读清单</span><strong>给创造力留一点空间</strong><p>来自你关注的作者与信息源</p><small>3 分钟阅读 · 示例文章</small></div>'},
];
const labels={ready:'已连接',connecting:'连接中',reauth_required:'需要授权',degraded:'连接异常',disconnected:'未连接',unavailable:'未接入'};
export function connectorCards(data,escape){
  return definitions.map(item=>{
    const health=(data.health||[]).find(entry=>entry.id===item.id);
    return `<article class="connector-card" data-connector="${item.id}"><header><span class="connector-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${item.path}"/></svg></span><h3>${item.name}</h3><span class="connector-status">预览</span></header>${item.preview}<footer>${escape(health?labels[health.state]||health.state:'未连接')} · 示例内容</footer></article>`;
  }).join('')+`<article class="connector-card notification-card"><header><h3>通知</h3><span class="connector-status">${data.notifications?.length||0} 条</span></header>${data.notifications?.length?data.notifications.map(item=>`<p>${escape(item.summary)}<small>${escape(new Date(item.occurredAt).toLocaleString())}</small></p>`).join(''):'<p>暂无通知<small>连接服务后，在这里集中查看</small></p>'}</article>`;
}
