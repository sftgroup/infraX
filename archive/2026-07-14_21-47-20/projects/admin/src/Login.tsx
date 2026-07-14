import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './App';

export default function Login() {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const navigate = useNavigate();
  const { setAuthed } = useAuth();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    try {
      const res = await fetch('/api/v2/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Invalid credentials');
      setAuthed(true);
      navigate('/');
    } catch {
      setErr('Invalid credentials');
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>⛓️</div>
          <div className="login-title">PocketX Collector</div>
          <div className="login-sub">Admin Panel</div>
        </div>
        {err && <div className="login-error">{err}</div>}
        <div className="form-group">
          <label className="form-label">Username</label>
          <input className="form-input" value={user} onChange={e => setUser(e.target.value)} placeholder="admin" autoFocus />
        </div>
        <div className="form-group">
          <label className="form-label">Password</label>
          <input className="form-input" type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="••••••" />
        </div>
        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px', marginTop: 8 }} type="submit">
          Sign In
        </button>
      </form>
    </div>
  );
}
