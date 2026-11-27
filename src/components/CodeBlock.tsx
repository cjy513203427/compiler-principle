import { highlightLine, type SnippetLanguage } from './highlight';
import { T } from '../i18n';

/** A read-only code snippet styled like an IDE editor tab. */
export function CodeBlock({
  code,
  language = 'text',
  title,
  label,
  className = '',
  lineNumbers = true,
}: {
  code: string;
  language?: SnippetLanguage;
  title?: string;
  label?: string;
  className?: string;
  lineNumbers?: boolean;
}) {
  const languageNames: Record<SnippetLanguage, string> = {
    grammar: T('文法'),
    regex: T('正则'),
    c: 'C',
    asm: T('汇编'),
    shell: 'Shell',
    text: T('文本'),
  };
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <figure className={`ide-snippet ${className}`}>
      <figcaption className="ide-bar">
        <span className="ide-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {title && <span className="ide-tab">{title}</span>}
        <span className="ide-lang">{languageNames[language]}</span>
      </figcaption>
      <pre
        className="ide-code"
        tabIndex={0}
        aria-label={label || title || T('{#0}代码', languageNames[language])}
      >
        <code>
          {lines.map((line, index) => (
            <span className="ide-line" key={index}>
              {lineNumbers && (
                <span className="ide-gutter" aria-hidden="true">
                  {index + 1}
                </span>
              )}
              <span className="ide-text">
                {line
                  ? highlightLine(line, language).map((piece, i) =>
                      piece.kind === 'plain' ? (
                        piece.text
                      ) : (
                        <span key={i} className={`tok-${piece.kind}`}>
                          {piece.text}
                        </span>
                      ),
                    )
                  : ' '}
              </span>
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}
