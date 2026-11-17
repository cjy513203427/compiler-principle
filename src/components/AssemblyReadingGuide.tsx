import { useState } from 'react';
import type { AssemblyTopic } from '../compiler/assembly/model';
import {
  assemblyBookReferences,
  assemblyReadingConventions,
  bookInstructionGroups,
  assemblyCompilerPatterns,
  independentAssemblyCourse,
} from '../content/assembly-reading';

export default function AssemblyReadingGuide({
  onExperiment,
}: {
  onExperiment: (topic: AssemblyTopic) => void;
}) {
  const [pattern, setPattern] = useState(0);
  const current = assemblyCompilerPatterns[pattern];
  return (
    <div className="asm-reading-guide">
      <section className="asm-reading-purpose">
        <span className="eyebrow">READ WHILE YOU NEED / 随书查阅</span>
        <h2>读到一段汇编，先确认它的上下文。</h2>
        <p>
          这份附录帮助阅读编译器的代码生成与优化示例。需要认识寄存器、内存、地址与位宽；这些基础，以及
          8086 / x86 的体系关系，适合在独立专题里系统学习。
        </p>
        <p>
          先查语法和传参位置，再查指令做了什么，最后看编译器为什么选择这种写法。已有交互对照仍可从上方“动手对照”打开。
        </p>
      </section>
      <section className="asm-book-section">
        <h2>原书入口 / 本次选读</h2>
        <div className="asm-book-links">
          {assemblyBookReferences.map((item) => (
            <article key={item.number}>
              <span>第 {item.number} 讲 · 已核对</span>
              <h3>{item.title}</h3>
              <p>{item.focus}</p>
              <a href={item.url} target="_blank" rel="noreferrer">
                打开原文 ↗
              </a>
            </article>
          ))}
        </div>
        <p className="figure-caption">
          核对日期：2026-11-16。只覆盖这两讲中选读的指令与写法，不代表全书指令清单；下方代码片段为自行编写的说明。
        </p>
      </section>
      <section className="asm-book-section">
        <h2>先分清：语法格式与调用约定</h2>
        <div className="asm-convention-list">
          {assemblyReadingConventions.map((item) => (
            <article key={item.place}>
              <h3>{item.place}</h3>
              <p>{item.syntax}</p>
              <p>{item.parameters}</p>
            </article>
          ))}
        </div>
        <p className="asm-reading-tip">
          Intel / AT&T 决定一条指令怎样写；ABI
          决定参数与返回值放在哪里。改写操作数顺序，不会自动改变调用约定。
        </p>
      </section>
      <section className="asm-book-section">
        <h2>原书选读指令 / 按用途查</h2>
        <div className="asm-book-instructions">
          {bookInstructionGroups.map((item) => (
            <details key={item.name}>
              <summary>
                <strong>{item.name}</strong>
                <span>
                  {item.task} · 第 {item.chapter} 讲
                </span>
              </summary>
              <p>{item.reading}</p>
              <pre>{item.form}</pre>
            </details>
          ))}
        </div>
      </section>
      <section className="asm-book-section">
        <h2>编译器常见写法 / 先看结果，再问原因</h2>
        <div className="asm-pattern-choices" aria-label="编译器汇编技巧">
          {assemblyCompilerPatterns.map((item, index) => (
            <button
              key={item.title}
              aria-pressed={index === pattern}
              onClick={() => setPattern(index)}
            >
              {item.title}
            </button>
          ))}
        </div>
        <article className="asm-pattern-detail" aria-label="当前汇编技巧">
          <span className="eyebrow">关联：第 {current.chapter} 讲</span>
          <h3>{current.question}</h3>
          <p>{current.explanation}</p>
          <div className="asm-pattern-comparison">
            <div>
              <span>展开观察</span>
              <pre>{current.before}</pre>
            </div>
            <div>
              <span>另一种安排</span>
              <pre>{current.after}</pre>
            </div>
          </div>
          <p className="asm-reading-tip">{current.limit}</p>
          <button className="button secondary" onClick={() => onExperiment(current.topic)}>
            {current.action} ↗
          </button>
        </article>
      </section>
      <details className="asm-independent-outline">
        <summary>汇编基础独立专题，应从哪里开始？</summary>
        <p>独立专题需要自己的学习顺序和练习，才能照顾没学过汇编的读者。这里先记录内容规划：</p>
        <ol>
          {independentAssemblyCourse.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
        <p>当前仓库保留随书速查与现有对照实验。独立专题尚未创建，也没有添加空的项目入口。</p>
      </details>
    </div>
  );
}
