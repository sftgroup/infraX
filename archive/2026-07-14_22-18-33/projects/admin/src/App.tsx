import { Routes, Route, useNavigate, useLocation, Navigate, Outlet } from 'react-router-dom';
import { useState, useEffect, createContext, useContext } from 'react';
import { LayoutDashboard, Wallet, Database, Shield, Key, Activity, DollarSign, FileText, Settings } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import WaasPanel from './pages/WaasPanel';
import DcPanel from './pages/DcPanel';
import VaultPanel from './pages/VaultPanel';
import MpcPanel from './pages/MpcPanel';
import DataPipeline from './pages/DataPipeline';
import Revenue from './pages/Revenue';
import SettingsPage from './pages/SettingsPage';
import Audit from './pages/Audit';
import Login from './Login';
import { api } from './lib';

interface AuthCtxType { authed: boolean; setAuthed: (v: boolean) => void; }
export const AuthCtx = createContext<AuthCtxType>({ authed: false, setAuthed: () => {} });
export const useAuth = () => useContext(AuthCtx);

const NAV = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { path: '/waas', label: 'WAAS', icon: Wallet },
  { path: '/dc', label: 'DC', icon: Database },
  { path: '/vault', label: 'Vault', icon: Shield },
  { path: '/mpc', label: 'MPC', icon: Key },
  { path: '/pipeline', label: 'Data Pipeline', icon: Activity },
  { path: '/revenue', label: 'Revenue', icon: DollarSign },
  { path: '/settings', label: 'Settings', icon: Settings },
  { path: '/audit', label: 'Audit', icon: FileText },
];

function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setAuthed } = useAuth();

  const isActive = (path: string, exact?: boolean) =>
    exact ? location.pathname === path : location.pathname.startsWith(path);

  const logout = () => {
    fetch('/api/v2/admin/logout', { method: 'POST', credentials: 'same-origin' });
    setAuthed(false);
    navigate('/login');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, var(--accent), #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>⛓️</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#e5e7eb' }}>PocketX</div>
            <div style={{ fontSize: 11, color: 'var(--dim)' }}>Admin Panel</div>
          </div>
        </div>
      </div>
      <nav className="sidebar-nav">
        {NAV.map(item => (
          <button key={item.path} className={`sidebar-item ${isActive(item.path, item.exact) ? 'active' : ''}`}
            onClick={() => navigate(item.path)}>
            <item.icon size={18} /> {item.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 500 }}>Admin</div>
        <div style={{ fontSize: 11, color: 'var(--dim)' }}>admin@pocketx.io</div>
        <button onClick={logout} style={{ marginTop: 8, background: 'transparent', border: '1px solid var(--border)', color: 'var(--dim)', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>Logout</button>
      </div>
    </aside>
  );
}

function AuthedLayout() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/waas" element={<WaasPanel />} />
          <Route path="/dc" element={<DcPanel />} />
          <Route path="/vault" element={<VaultPanel />} />
          <Route path="/mpc" element={<MpcPanel />} />
          <Route path="/pipeline" element={<DataPipeline />} />
          <Route path="/revenue" element={<Revenue />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { authed, setAuthed } = useAuth();
  const [loading, setLoading] = useState(!authed);

  useEffect(() => {
    if (authed) { setLoading(false); return; }
    api('/admin/dashboard')
      .then(() => { setAuthed(true); setLoading(false); })
      .catch(() => { setAuthed(false); setLoading(false); });
  }, []);

  if (loading) return <div className="loading"><span className="spin" />Loading...</div>;
  if (!authed) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const [authed, setAuthed] = useState(false);

  return (
    <AuthCtx.Provider value={{ authed, setAuthed }}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<RequireAuth><AuthedLayout /></RequireAuth>} />
      </Routes>
    </AuthCtx.Provider>
  );
}
