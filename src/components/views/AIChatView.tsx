import { useState, useRef, useEffect } from 'react';
import { Send, Trash2, MessageSquare, AlertTriangle } from 'lucide-react';

// The chat talks to a Cloudflare Worker proxy that holds the Anthropic API key
// server-side. The model, system prompt, and token cap live in the worker
// (see worker/src/index.ts) so the key is never exposed in this public bundle.
const PROXY_URL = import.meta.env.VITE_AI_PROXY_URL;

const STARTER_QUESTIONS = [
  'How do I hire the Underbutler?',
  'What servants does the Kitchen require?',
  'Explain courtship scoring',
  'Can servants substitute for each other?',
];

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export function AIChatView() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading || !PROXY_URL) return;
    setError(null);

    const userMsg: Message = { role: 'user', content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const err = (data as { error?: { message?: string } | string }).error;
        const detail = typeof err === 'string' ? err : err?.message;
        setError(`Error ${response.status}: ${detail ?? response.statusText}`);
        setMessages(prev => prev.slice(0, -1));
        return;
      }

      const data = await response.json() as {
        content?: Array<{ type: string; text: string }>;
      };
      const reply = data.content?.find(c => c.type === 'text')?.text ?? '';
      setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch {
      setError('Network error. Please check your connection and try again.');
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  };

  if (!PROXY_URL) {
    return (
      <div className="chat-view">
        <div className="section-header">
          <h1>Ask the Rulebook</h1>
          <p>Get AI-powered answers to your Obsession questions</p>
        </div>
        <div className="api-key-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.5rem' }}>
            <AlertTriangle size={18} color="var(--gold)" />
            <h3>AI assistant not configured</h3>
          </div>
          <p style={{ fontSize: '0.83rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            The Ask the Rulebook feature needs its backend proxy URL set at build time via the{' '}
            <code>VITE_AI_PROXY_URL</code> environment variable. See{' '}
            <code>worker/README.md</code> in the repository for one-time setup instructions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '1rem 1rem 0.5rem', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <MessageSquare size={16} color="var(--gold)" />
          <span style={{ fontFamily: "'Playfair Display', serif", color: 'var(--gold-l)', fontWeight: 600, fontSize: '1rem' }}>
            Ask the Rulebook
          </span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            style={{
              background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)',
              borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', display: 'flex',
              alignItems: 'center', gap: '4px', fontSize: '0.75rem',
            }}
          >
            <Trash2 size={12} />
            Clear
          </button>
        )}
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>🎩</div>
            <p style={{ fontFamily: "'Playfair Display', serif", color: 'var(--text-dim)', marginBottom: '0.5rem', fontSize: '1rem' }}>
              Ask me anything about Obsession
            </p>
            <p style={{ fontSize: '0.8rem', lineHeight: 1.6 }}>
              Servants, tiles, families, scoring, special rounds — I know the rulebook.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg ${msg.role}`}>
            {msg.content.split('\n').map((line, j) => (
              <span key={j}>
                {line}
                {j < msg.content.split('\n').length - 1 && <br />}
              </span>
            ))}
          </div>
        ))}

        {loading && (
          <div className="chat-msg ai thinking">
            Thinking...
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="chat-error">{error}</div>
      )}

      {messages.length === 0 && (
        <div className="chat-suggestions">
          {STARTER_QUESTIONS.map(q => (
            <button
              key={q}
              className="chat-suggestion"
              onClick={() => sendMessage(q)}
              disabled={loading}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder="Ask about rules, servants, tiles..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          style={{ minHeight: '38px', maxHeight: '120px', overflowY: 'auto' }}
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={!input.trim() || loading}
          style={{
            background: input.trim() && !loading ? 'var(--gold)' : 'var(--surface2)',
            color: input.trim() && !loading ? '#1a0f00' : 'var(--text-muted)',
            border: 'none', borderRadius: '8px', padding: '0 14px',
            cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, height: '38px', transition: 'all 0.2s',
          }}
          aria-label="Send message"
        >
          <Send size={16} />
        </button>
      </div>

      <div style={{ textAlign: 'center', padding: '0.5rem 1rem', borderTop: '1px solid var(--border)' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: '0.72rem' }}>
          Powered by Claude · Answers may be imperfect — confirm with the rulebook
        </span>
      </div>
    </div>
  );
}
