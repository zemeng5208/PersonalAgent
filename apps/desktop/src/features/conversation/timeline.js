// A view projection only; Live messages never become Runtime tasks.
export function conversationTimeline(tasks = [], messages = []) {
  return [...tasks.map(task => ({kind:'task',createdAt:task.createdAt,value:task})),
    ...messages.map(message => ({kind:'message',createdAt:message.createdAt,value:message}))]
    .sort((a,b) => (Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0));
}
