import './mentor-human-entry.css';
export function MentorHumanEntry({ current = false }: { current?: boolean }) {
  return <a className="mentor-human-entry" href="/me/mentors" aria-current={current ? 'page' : undefined}
    aria-label="蔓藤导师，真人，付费，看不到你的对话">
    <span className="mentor-human-circle" aria-hidden="true">导</span>
    <span><span className="mentor-human-name">蔓藤导师 <span className="mentor-human-tag">真人</span></span>
      <span className="mentor-human-subtitle">付费 · 看不到你的对话</span></span>
  </a>;
}
