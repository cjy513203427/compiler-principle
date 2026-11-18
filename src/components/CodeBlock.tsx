import { highlightLine, type SnippetLanguage } from './highlight';

const languageNames: Record<SnippetLanguage, string> = {
  grammar: '文法',
  regex: '正则',
  c: 'C',
  asm: '汇编',
  shell: 'Shell',
  text: '文本',
};

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
        aria-label={label || title || `${languageNames[language]}代码`}
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
