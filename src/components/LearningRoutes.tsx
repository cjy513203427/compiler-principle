import type { Stage } from '../compiler/model';
import { lessons } from '../content/lessons';
import { learningRoutes, lessonConnections } from '../content/learning';
import { T } from '../i18n';
import '../styles-learning.css';

const lessonFor = (stage: Stage) => lessons.find((lesson) => lesson.id === stage)!;

export function LearningRoutes({
  onNavigate,
  completed,
}: {
  onNavigate: (stage: Stage) => void;
  completed: Stage[];
}) {
  return (
    <div className="study-routes" aria-label={T('建议学习路线')}>
      {learningRoutes.map((route) => (
        <article className="study-route" key={route.id}>
          <h3>{route.title}</h3>
          <p>{route.description}</p>
          <ol>
            {route.stages.map((stage) => {
              const lesson = lessonFor(stage);
              return (
                <li key={stage}>
                  <button
                    aria-label={T('打开实验 {#0} {#1}', lesson.number, lesson.title)}
                    onClick={() => onNavigate(stage)}
                  >
                    <span>{lesson.number}</span>
                    {lesson.title}
                    {completed.includes(stage) && <small>{T('已复习')}</small>}
                  </button>
                </li>
              );
            })}
          </ol>
          <span className="route-progress">
            {T(
              '{#0} / {#1} 已复习',
              route.stages.filter((stage) => completed.includes(stage)).length,
              route.stages.length,
            )}
          </span>
        </article>
      ))}
    </div>
  );
}

export function LessonConnections({
  stage,
  onNavigate,
}: {
  stage: Stage;
  onNavigate: (stage: Stage) => void;
}) {
  const connections = lessonConnections[stage];
  return (
    <nav className="lesson-connections" aria-label={T('阅读衔接')}>
      <p>{T('按需要补前置知识，或接着探索相关实验。')}</p>
      {([
        { key: 'before', title: T('建议先看'), action: T('先学'), stages: connections.before },
        { key: 'after', title: T('接着探索'), action: T('继续'), stages: connections.after },
      ] as const).map((group) => group.stages.length > 0 && (
        <div key={group.key}>
          <strong>{group.title}</strong>
          <div>
            {group.stages.map((id) => {
              const lesson = lessonFor(id);
              return (
                <button key={id} onClick={() => onNavigate(id)}>
                  {T('{#0}：{#1} {#2}', group.action, lesson.number, lesson.title)}{' '}
                  <span aria-hidden="true">→</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
