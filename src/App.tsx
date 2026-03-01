import React, { useState, useEffect } from 'react';
import { 
  Home, 
  Settings, 
  Activity, 
  Calendar, 
  Menu, 
  X, 
  Cpu, 
  Thermometer, 
  Lightbulb, 
  Users,
  RefreshCw,
  Zap,
  BrainCircuit,
  ThermometerSun,
  Moon,
  Plane,
  Plus,
  Minus,
  LogOut,
  Wifi,
  WifiOff,
  ShieldAlert,
  UserPlus,
  Trash2,
  Scan,
  CheckCircle,
  AlertCircle,
  ArrowUpCircle,
  Info
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './components/ui/card';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ScheduleCalendar } from './components/ScheduleCalendar';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [settingsTab, setSettingsTab] = useState('general');
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [currentUser, setCurrentUser] = useState<{id: number, username: string, role: string} | null>(null);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  
  const [settings, setSettings] = useState({
    ha_url: '',
    ha_token: '',
    telegram_bot_token: '',
    telegram_chat_id: '',
    user_ai_context: '',
    dashboard_graph_zones: '[]',
    ai_realtime_interval: '5',
    ai_lookback_days: '14',
    ai_context_window_hours: '2',
    ai_model: 'gemini-3-flash-preview',
    climate_abs_min: '55',
    climate_abs_max: '80',
    dashboard_default_timeframe: '24h',
    ghost_mode_hvac: 'true',
    ghost_mode_whole_home: 'true'
  });

  const [climateSettings, setClimateSettings] = useState({
    master_home: 72,
    master_away: 65,
    master_night: 68,
    zone_modifiers: {} as Record<string, number>
  });

  const [history, setHistory] = useState<any[]>([]);
  const [graphData, setGraphData] = useState<any[]>([]);
  const [graphTimeframe, setGraphTimeframe] = useState('24h');
  const [schedules, setSchedules] = useState<any[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [reasoning, setReasoning] = useState<any[]>([]);
  const [entities, setEntities] = useState<any[]>([]);
  const [trackedEntities, setTrackedEntities] = useState<Record<string, { tracked: boolean, notes: string }>>({});
  const [isGenerating, setIsGenerating] = useState(false);
  const [haStatus, setHaStatus] = useState({ status: 'disconnected', error: '' });
  const [usersList, setUsersList] = useState<any[]>([]);
  const [occupancyRoster, setOccupancyRoster] = useState<any[]>([]);
  const [newOccupancy, setNewOccupancy] = useState({ name: '', entity_id: '' });
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'viewer' });
  const [updateStatus, setUpdateStatus] = useState({ checking: false, available: false, message: '', updating: false });
  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceTypeFilter, setDeviceTypeFilter] = useState('all');
  const [deviceStatusFilter, setDeviceStatusFilter] = useState('all');
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState({ progress: 0, entity: '' });
  const [scanResults, setScanResults] = useState<{entity_id: string, reason: string}[]>([]);
  const [scheduleViewMode, setScheduleViewMode] = useState<'calendar' | 'json'>('calendar');

  useEffect(() => {
    if (currentUser) {
      fetchSettings();
      fetchHistory();
      fetchSchedules();
      fetchInsights();
      fetchReasoning();
      fetchEntities();
      fetchHaStatus();
      fetchOccupancy();
      if (currentUser.role === 'admin') {
        fetchUsers();
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/api/ws`;
      const ws = new WebSocket(wsUrl);
      
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'NEW_HISTORY') {
          setHistory(prev => [message.data, ...prev].slice(0, 100));
          // If the new history event is for a graphed zone, refresh the graph data
          if (settings.dashboard_graph_zones && settings.dashboard_graph_zones.includes(message.data.entity_id)) {
            fetchGraphData(settings.dashboard_graph_zones, graphTimeframe);
          }
        } else if (message.type === 'NEW_REASONING') {
          fetchReasoning();
          fetchSchedules();
        } else if (message.type === 'HA_STATUS') {
          setHaStatus(message.status);
        } else if (message.type === 'SYNC_PROGRESS') {
          setIsSyncing(true);
          setSyncProgress({ progress: message.progress, entity: message.entity });
        } else if (message.type === 'SYNC_COMPLETE') {
          setIsSyncing(false);
          setSyncProgress({ progress: 100, entity: 'Complete' });
          fetchHistory();
        }
      };
      
      return () => ws.close();
    }
  }, [currentUser, settings.dashboard_graph_zones]);

  useEffect(() => {
    if (settings.dashboard_graph_zones) {
      fetchGraphData(settings.dashboard_graph_zones, graphTimeframe);
    }
  }, [settings.dashboard_graph_zones, graphTimeframe]);

  const fetchGraphData = async (zonesStr: string, timeframe: string) => {
    try {
      const res = await fetch(`/api/history/graph?zones=${encodeURIComponent(zonesStr)}&timeframe=${timeframe}`);
      const data = await res.json();
      setGraphData(data);
    } catch (e) {
      console.error("Failed to fetch graph data", e);
    }
  };

  const fetchHaStatus = async () => {
    const res = await fetch('/api/ha/status');
    const data = await res.json();
    setHaStatus({ status: data.status, error: data.error || '' });
  };

  const handleForceConnect = async () => {
    setHaStatus({ status: 'connecting', error: '' });
    await fetch('/api/ha/force-connect', { method: 'POST' });
    fetchHaStatus();
  };

  const fetchUsers = async () => {
    const res = await fetch('/api/users');
    const data = await res.json();
    setUsersList(data);
  };

  const fetchOccupancy = async () => {
    const res = await fetch('/api/occupancy');
    const data = await res.json();
    setOccupancyRoster(data);
  };

  const handleAddOccupancy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newOccupancy.name || !newOccupancy.entity_id) return;
    await fetch('/api/occupancy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newOccupancy)
    });
    setNewOccupancy({ name: '', entity_id: '' });
    fetchOccupancy();
  };

  const handleDeleteOccupancy = async (id: number) => {
    await fetch(`/api/occupancy/${id}`, { method: 'DELETE' });
    fetchOccupancy();
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser)
    });
    setNewUser({ username: '', password: '', role: 'viewer' });
    fetchUsers();
  };

  const handleDeleteUser = async (id: number) => {
    await fetch(`/api/users/${id}`, { method: 'DELETE' });
    fetchUsers();
  };

  const fetchSettings = async () => {
    const res = await fetch('/api/settings');
    const data = await res.json();
    setSettings(prev => {
      const merged = { ...prev, ...data };
      // Ensure all values are strings to avoid uncontrolled input issues
      Object.keys(merged).forEach(key => {
        if (merged[key] === null || merged[key] === undefined) {
          merged[key] = '';
        }
      });
      return merged;
    });
    if (data.dashboard_default_timeframe) {
      setGraphTimeframe(data.dashboard_default_timeframe);
    }
    setClimateSettings({
      master_home: Number(data.climate_master_home) || 72,
      master_away: Number(data.climate_master_away) || 65,
      master_night: Number(data.climate_master_night) || 68,
      zone_modifiers: data.climate_zone_modifiers ? JSON.parse(data.climate_zone_modifiers) : {}
    });
  };

  const fetchHistory = async () => {
    const res = await fetch('/api/history');
    const data = await res.json();
    setHistory(data);
  };

  const fetchSchedules = async () => {
    const res = await fetch('/api/schedules');
    const data = await res.json();
    setSchedules(data);
  };

  const fetchInsights = async () => {
    const res = await fetch('/api/insights');
    const data = await res.json();
    setInsights(data);
  };

  const fetchReasoning = async () => {
    const res = await fetch('/api/reasoning');
    const data = await res.json();
    setReasoning(data);
  };

  const fetchEntities = async () => {
    try {
      const res = await fetch('/api/ha/entities');
      const data = await res.json();
      if (data.entities) {
        setEntities(data.entities);
        setTrackedEntities(data.tracked);
      }
    } catch (e) {
      console.error("Failed to fetch entities");
    }
  };

  const handleToggleTracked = async (entity_id: string, tracked: boolean, notes: string = '') => {
    setTrackedEntities(prev => ({ ...prev, [entity_id]: { tracked, notes } }));
    await fetch('/api/ha/tracked', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id, tracked, notes })
    });
  };

  const handleUpdateNotes = async (entity_id: string, notes: string) => {
    const current = trackedEntities[entity_id] || { tracked: false };
    handleToggleTracked(entity_id, current.tracked, notes);
  };

  useEffect(() => {
    // Background loops are now handled by the server.
    // This frontend loop is removed.
  }, []);

  const executeRealTimeAIControl = async () => {
    try {
      const res = await fetch('/api/ai/real-time-control', { method: 'POST' });
      if (!res.ok) throw new Error("Failed to trigger real-time control");
      fetchReasoning();
    } catch (e) {
      console.error("Real-time control failed", e);
    }
  };

  const handleHistorySync = async () => {
    setIsSyncing(true);
    setSyncProgress({ progress: 0, entity: 'Starting...' });
    try {
      const res = await fetch('/api/ha/sync-history', { method: 'POST' });
      if (!res.ok) throw new Error("Failed to start history sync");
    } catch (e) {
      console.error("History sync failed", e);
      setIsSyncing(false);
    }
  };

  const handleAIScan = async () => {
    setIsScanning(true);
    setScanResults([]);
    try {
      const res = await fetch('/api/ai/scan-entities', { method: 'POST' });
      if (!res.ok) throw new Error("Failed to scan entities via AI");
      const suggestions = await res.json();
      if (Array.isArray(suggestions)) {
        setScanResults(suggestions);
      } else {
        console.error("Invalid scan results", suggestions);
      }
    } catch (e: any) {
      console.error("AI Scan failed", e.message);
      alert("AI Scan failed: " + e.message);
    } finally {
      setIsScanning(false);
    }
  };

  const handleBulkTrack = async (entitiesToTrack: {entity_id: string, notes: string}[]) => {
    try {
      const res = await fetch('/api/ha/bulk-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities: entitiesToTrack })
      });
      const data = await res.json();
      if (data.success) {
        fetchEntities();
        setScanResults([]);
      }
    } catch (e) {
      console.error("Bulk track failed", e);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(loginForm)
    });
    const data = await res.json();
    if (data.success) {
      setCurrentUser(data.user);
    } else {
      alert('Invalid credentials');
    }
  };

  const handleLogout = () => {
    setCurrentUser(null);
    setLoginForm({ username: '', password: '' });
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    alert('Settings saved');
  };

  const handleSyncSystemData = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch('/api/ha/sync-system-data', { method: 'POST' });
      if (!res.ok) throw new Error("Failed to sync system data");
      const data = await res.json();
      alert(data.message || "System data synced successfully!");
    } catch (e: any) {
      console.error("Sync failed", e);
      alert("Sync failed: " + e.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSyncAutomationsScripts = async () => {
    setIsSyncing(true);
    try {
      const res = await fetch('/api/ha/sync-automations-scripts', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to sync automations and scripts");
      alert(`Successfully synced ${data.count} automations and scripts for AI learning.`);
    } catch (e: any) {
      console.error("Sync failed", e);
      alert("Sync failed: " + e.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleUpdateSingleSetting = async (key: string, value: string) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });
  };

  const handleSaveClimateSettings = async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        climate_master_home: climateSettings.master_home,
        climate_master_away: climateSettings.master_away,
        climate_master_night: climateSettings.master_night,
        climate_zone_modifiers: JSON.stringify(climateSettings.zone_modifiers)
      })
    });
    alert('Climate settings saved');
  };

  const handleClimateChange = (key: string, delta: number) => {
    setClimateSettings(prev => ({ ...prev, [key]: (prev as any)[key] + delta }));
  };

  const handleZoneOffsetChange = (entity_id: string, delta: number) => {
    setClimateSettings(prev => {
      const currentOffset = prev.zone_modifiers[entity_id] || 0;
      return {
        ...prev,
        zone_modifiers: {
          ...prev.zone_modifiers,
          [entity_id]: currentOffset + delta
        }
      };
    });
  };

  const handleGenerateSchedule = async () => {
    setIsGenerating(true);
    try {
      const res = await fetch('/api/ai/generate-schedule', { method: 'POST' });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || "Failed to generate schedule via AI");
      }
      
      fetchInsights();
      fetchReasoning();
      fetchSchedules();
      alert("Analysis and schedule generation completed successfully!");
    } catch (e: any) {
      console.error("Analysis failed", e);
      alert("Analysis failed: " + e.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleToggleGraphZone = (entity_id: string) => {
    const currentZones = JSON.parse(settings.dashboard_graph_zones || '[]');
    let newZones;
    if (currentZones.includes(entity_id)) {
      newZones = currentZones.filter((id: string) => id !== entity_id);
    } else {
      newZones = [...currentZones, entity_id];
    }
    handleUpdateSingleSetting('dashboard_graph_zones', JSON.stringify(newZones));
  };

  const handleCheckUpdate = async () => {
    setUpdateStatus(prev => ({ ...prev, checking: true, message: '' }));
    try {
      const res = await fetch('/api/system/check-update');
      const data = await res.json();
      setUpdateStatus(prev => ({ ...prev, checking: false, available: data.updateAvailable, message: data.message }));
    } catch (e) {
      setUpdateStatus(prev => ({ ...prev, checking: false, message: 'Failed to check for updates.' }));
    }
  };

  const handleApplyUpdate = async () => {
    setUpdateStatus(prev => ({ ...prev, updating: true }));
    try {
      const res = await fetch('/api/system/update', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setUpdateStatus(prev => ({ ...prev, updating: false, available: false, message: data.message }));
      } else {
        setUpdateStatus(prev => ({ ...prev, updating: false, message: 'Update failed: ' + data.error }));
      }
    } catch (e) {
      setUpdateStatus(prev => ({ ...prev, updating: false, message: 'Failed to apply update.' }));
    }
  };

  const filteredEntities = entities.filter(entity => {
    const matchesSearch = (entity.friendly_name || '').toLowerCase().includes(deviceSearch.toLowerCase()) || 
                          (entity.entity_id || '').toLowerCase().includes(deviceSearch.toLowerCase());
    
    const matchesType = deviceTypeFilter === 'all' || entity.domain === deviceTypeFilter;
    
    const isTracked = trackedEntities[entity.entity_id]?.tracked || false;
    const matchesStatus = deviceStatusFilter === 'all' || 
                          (deviceStatusFilter === 'tracked' && isTracked) || 
                          (deviceStatusFilter === 'untracked' && !isTracked);
                          
    return matchesSearch && matchesType && matchesStatus;
  });

  const uniqueDomains = Array.from(new Set(entities.map(e => e.domain))).sort();

  if (!currentUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] text-white">
        <Card className="w-full max-w-md bg-[#141414] border-white/10 text-white">
          <CardHeader className="text-center">
            <div className="mx-auto w-12 h-12 bg-white/5 rounded-full flex items-center justify-center mb-4 border border-white/10">
              <Cpu className="w-6 h-6 text-white" />
            </div>
            <CardTitle className="text-2xl font-light tracking-tight">HomeBrain AI</CardTitle>
            <CardDescription className="text-white/50">Sign in to manage your smart home</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-white/70">Username</Label>
                <Input 
                  id="username" 
                  className="bg-white/5 border-white/10 text-white focus-visible:ring-white/20"
                  value={loginForm.username}
                  onChange={e => setLoginForm({...loginForm, username: e.target.value})}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-white/70">Password</Label>
                <Input 
                  id="password" 
                  type="password"
                  className="bg-white/5 border-white/10 text-white focus-visible:ring-white/20"
                  value={loginForm.password}
                  onChange={e => setLoginForm({...loginForm, password: e.target.value})}
                />
              </div>
              <Button type="submit" className="w-full bg-white text-black hover:bg-white/90">
                Sign In
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Process history for the chart
  const graphZones = JSON.parse(settings.dashboard_graph_zones || '[]');
  const chartDataMap: Record<string, any> = {};
  
    graphData.forEach(item => {
      if (graphZones.includes(item.entity_id)) {
        // Handle both normalized and ISO timestamps
        const tsStr = item.last_changed.includes('T') || item.last_changed.includes('+') || item.last_changed.includes('Z') 
          ? item.last_changed 
          : item.last_changed + 'Z';
        const date = new Date(tsStr);
        const timeKey = item.last_changed; // Use unique timestamp to avoid aggregation
        
        if (!chartDataMap[timeKey]) {
          chartDataMap[timeKey] = { time: timeKey, timestamp: date.getTime() };
        }
        
        try {
          const attrs = JSON.parse(item.attributes);
          // 1. Try current_temperature (climate)
          // 2. Try state (sensor)
          const temp = attrs.current_temperature !== undefined 
            ? Number(attrs.current_temperature) 
            : Number(item.state);
            
          if (!isNaN(temp)) {
            chartDataMap[timeKey][item.entity_id] = temp;
          }
        } catch(e) {}
      }
    });
  
  const chartData = Object.values(chartDataMap).sort((a: any, b: any) => a.timestamp - b.timestamp);
  if (chartData.length === 0) {
    // Fallback mock data if no real history for zones
    chartData.push(
      { time: '00:00', 'climate.zone_1_living_room': 68, 'climate.zone_2_master': 66 },
      { time: '04:00', 'climate.zone_1_living_room': 67, 'climate.zone_2_master': 65 },
      { time: '08:00', 'climate.zone_1_living_room': 70, 'climate.zone_2_master': 68 },
      { time: '12:00', 'climate.zone_1_living_room': 72, 'climate.zone_2_master': 70 },
      { time: '16:00', 'climate.zone_1_living_room': 73, 'climate.zone_2_master': 71 },
      { time: '20:00', 'climate.zone_1_living_room': 71, 'climate.zone_2_master': 69 }
    );
  }

  const colors = ['#f97316', '#3b82f6', '#10b981', '#8b5cf6', '#ec4899', '#eab308', '#06b6d4'];

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex font-sans text-slate-900">
      <aside className={`\${isSidebarOpen ? 'w-64' : 'w-20'} bg-[#0a0a0a] text-white transition-all duration-300 flex flex-col border-r border-white/10`}>
        <div className="h-16 flex items-center justify-between px-4 border-b border-white/10">
          {isSidebarOpen && <span className="font-light tracking-tight text-white text-lg flex items-center gap-2"><Cpu className="w-5 h-5 text-white/70"/> HomeBrain</span>}
          <button onClick={() => setSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
            <Menu className="w-5 h-5 text-white/70" />
          </button>
        </div>
        
        <nav className="flex-1 py-6 space-y-1 px-3">
          {[
            { id: 'dashboard', icon: Home, label: 'Dashboard' },
            { id: 'occupancy', icon: Users, label: 'Occupancy' },
            { id: 'climate', icon: ThermometerSun, label: 'Master Climate' },
            { id: 'history', icon: Activity, label: 'History & Data' },
            { id: 'schedules', icon: Calendar, label: 'AI Schedules' },
            { id: 'reasoning', icon: BrainCircuit, label: 'AI Reasoning' },
            { id: 'settings', icon: Settings, label: 'Settings' },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center ${isSidebarOpen ? 'px-4' : 'justify-center'} py-3 rounded-xl transition-all ${activeTab === item.id ? 'bg-white text-black font-medium shadow-sm' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}
            >
              <item.icon className={`w-5 h-5 ${isSidebarOpen ? 'mr-3' : ''}`} />
              {isSidebarOpen && <span>{item.label}</span>}
            </button>
          ))}
        </nav>
        
        <div className="p-4 border-t border-white/10">
          {isSidebarOpen ? (
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{currentUser.username}</span>
                <span className="text-xs text-white/40 capitalize">{currentUser.role}</span>
              </div>
              <button onClick={handleLogout} className="p-2 hover:bg-white/10 rounded-lg text-white/60 hover:text-white transition-colors">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button onClick={handleLogout} className="w-full flex justify-center p-2 hover:bg-white/10 rounded-lg text-white/60 hover:text-white transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 shadow-sm z-10">
          <h1 className="text-xl font-medium tracking-tight text-slate-800 capitalize">{activeTab.replace('-', ' ')}</h1>
          <div className="flex items-center gap-4">
            <div className={`flex flex-col items-end`}>
              <div className={`flex items-center px-3 py-1.5 rounded-full text-xs font-medium border ${haStatus.status === 'connected' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : haStatus.status === 'connecting' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
                {haStatus.status === 'connected' ? <Wifi className="w-3.5 h-3.5 mr-1.5" /> : <WifiOff className="w-3.5 h-3.5 mr-1.5" />}
                {haStatus.status === 'connected' ? 'HA Connected' : haStatus.status === 'connecting' ? 'Connecting...' : 'HA Disconnected'}
              </div>
              {haStatus.error && haStatus.status !== 'connected' && (
                <span className="text-[10px] text-rose-500 mt-1 max-w-[200px] truncate" title={haStatus.error}>
                  {haStatus.error}
                </span>
              )}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-auto p-8">
          {activeTab === 'dashboard' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card>
                  <CardContent className="p-6 flex items-center space-x-4">
                    <div className="p-3 bg-orange-100 text-orange-600 rounded-full">
                      <Thermometer className="w-6 h-6" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-500">Avg Temperature</p>
                      <h3 className="text-2xl font-bold">21.5°C</h3>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-6 flex items-center space-x-4">
                    <div className="p-3 bg-yellow-100 text-yellow-600 rounded-full">
                      <Lightbulb className="w-6 h-6" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-500">Active Lights</p>
                      <h3 className="text-2xl font-bold">4</h3>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-6 flex items-center space-x-4">
                    <div className="p-3 bg-blue-100 text-blue-600 rounded-full">
                      <Users className="w-6 h-6" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-500">People Home</p>
                      <h3 className="text-2xl font-bold">2</h3>
                    </div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="col-span-1 lg:col-span-2">
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <div>
                      <CardTitle>Zone Temperatures</CardTitle>
                      <CardDescription>Historical temperature data for tracked zones</CardDescription>
                    </div>
                    <select 
                      className="h-8 px-2 py-1 border border-slate-200 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                      value={graphTimeframe}
                      onChange={(e) => setGraphTimeframe(e.target.value)}
                    >
                      <option value="24h">Last 24 Hours</option>
                      <option value="7d">Last 7 Days</option>
                      <option value="30d">Last 30 Days</option>
                      <option value="all">All Time</option>
                    </select>
                  </CardHeader>
                  <CardContent className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                        <XAxis 
                          dataKey="timestamp" 
                          type="number"
                          domain={['dataMin', 'dataMax']}
                          stroke="#64748b" 
                          fontSize={10} 
                          tickLine={false} 
                          axisLine={false}
                          tickFormatter={(ts) => {
                            const d = new Date(ts);
                            if (graphTimeframe === '24h') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
                          }}
                        />
                        <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
                        <Tooltip 
                          labelFormatter={(ts) => new Date(ts).toLocaleString()}
                          contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        />
                        {graphZones.map((zoneId: string, idx: number) => (
                          <Line 
                            key={zoneId}
                            type="monotone" 
                            dataKey={zoneId} 
                            name={entities.find(e => e.entity_id === zoneId)?.friendly_name || zoneId}
                            stroke={colors[idx % colors.length]} 
                            strokeWidth={2} 
                            dot={false}
                            connectNulls={true}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>

                <Card className="col-span-1 lg:col-span-2">
                  <CardHeader>
                    <CardTitle>Recent AI Insights</CardTitle>
                    <CardDescription>Observations from your home data</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {insights.length > 0 ? insights.map((insight: any) => (
                        <div key={insight.id} className="flex items-start space-x-3 p-3 bg-slate-50 rounded-lg border border-slate-100">
                          <Zap className="w-5 h-5 text-indigo-500 mt-0.5 flex-shrink-0" />
                          <p className="text-sm text-slate-700">{insight.content}</p>
                        </div>
                      )) : (
                        <div className="text-sm text-slate-500 text-center py-4">No insights generated yet. Run the daily analysis.</div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {activeTab === 'occupancy' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-lg font-semibold">Occupancy Roster</h2>
                  <p className="text-sm text-slate-500">Manage people and their Home Assistant tracker entities.</p>
                </div>
              </div>
              
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <Card className="lg:col-span-1">
                  <CardHeader>
                    <CardTitle>Add Person</CardTitle>
                    <CardDescription>Link a name to a tracker entity</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form onSubmit={handleAddOccupancy} className="space-y-4">
                      <div className="space-y-2">
                        <Label>Name</Label>
                        <Input 
                          placeholder="e.g. John Doe"
                          value={newOccupancy.name}
                          onChange={e => setNewOccupancy({...newOccupancy, name: e.target.value})}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>HA Entity ID</Label>
                        <select 
                          className="w-full h-10 px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                          value={newOccupancy.entity_id}
                          onChange={e => setNewOccupancy({...newOccupancy, entity_id: e.target.value})}
                        >
                          <option value="">Select a tracker...</option>
                          {entities
                            .filter(e => e.domain === 'person' || e.domain === 'device_tracker')
                            .sort((a, b) => (a.friendly_name || a.entity_id).localeCompare(b.friendly_name || b.entity_id))
                            .map(entity => (
                              <option key={entity.entity_id} value={entity.entity_id}>
                                {entity.friendly_name || entity.entity_id} ({entity.entity_id})
                              </option>
                            ))}
                        </select>
                      </div>
                      <Button type="submit" className="w-full bg-slate-900 text-white">Add to Roster</Button>
                    </form>
                  </CardContent>
                </Card>

                <Card className="lg:col-span-2">
                  <CardHeader>
                    <CardTitle>Current Roster</CardTitle>
                    <CardDescription>Tracked individuals and their current status</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="text-xs text-slate-500 uppercase bg-slate-50">
                          <tr>
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Entity ID</th>
                            <th className="px-4 py-3">Status</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {occupancyRoster.map(person => (
                            <tr key={person.id} className="hover:bg-slate-50/50">
                              <td className="px-4 py-3 font-medium">{person.name}</td>
                              <td className="px-4 py-3 font-mono text-xs text-slate-500">{person.entity_id}</td>
                              <td className="px-4 py-3">
                                <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${person.status === 'home' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                                  {person.status}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Button variant="ghost" size="icon" onClick={() => handleDeleteOccupancy(person.id)} className="text-rose-500 hover:text-rose-700 hover:bg-rose-50">
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </td>
                            </tr>
                          ))}
                          {occupancyRoster.length === 0 && (
                            <tr>
                              <td colSpan={4} className="px-4 py-8 text-center text-slate-500">No one in the roster yet.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}

          {activeTab === 'climate' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-lg font-semibold">Master Climate Control</h2>
                  <p className="text-sm text-slate-500">Set base temperatures for the entire house, then dial in specific zones below.</p>
                </div>
                <Button onClick={handleSaveClimateSettings} className="bg-indigo-600 hover:bg-indigo-700">
                  Save Climate Settings
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center text-lg"><Home className="w-5 h-5 mr-2 text-orange-500"/> Home (Day)</CardTitle>
                    <CardDescription>When people are active</CardDescription>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <Button variant="outline" size="icon" onClick={() => handleClimateChange('master_home', -1)}><Minus className="w-4 h-4"/></Button>
                    <span className="text-4xl font-light">{climateSettings.master_home}°</span>
                    <Button variant="outline" size="icon" onClick={() => handleClimateChange('master_home', 1)}><Plus className="w-4 h-4"/></Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center text-lg"><Plane className="w-5 h-5 mr-2 text-blue-500"/> Away</CardTitle>
                    <CardDescription>When the house is empty</CardDescription>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <Button variant="outline" size="icon" onClick={() => handleClimateChange('master_away', -1)}><Minus className="w-4 h-4"/></Button>
                    <span className="text-4xl font-light">{climateSettings.master_away}°</span>
                    <Button variant="outline" size="icon" onClick={() => handleClimateChange('master_away', 1)}><Plus className="w-4 h-4"/></Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center text-lg"><Moon className="w-5 h-5 mr-2 text-indigo-500"/> Night</CardTitle>
                    <CardDescription>When everyone is asleep</CardDescription>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between">
                    <Button variant="outline" size="icon" onClick={() => handleClimateChange('master_night', -1)}><Minus className="w-4 h-4"/></Button>
                    <span className="text-4xl font-light">{climateSettings.master_night}°</span>
                    <Button variant="outline" size="icon" onClick={() => handleClimateChange('master_night', 1)}><Plus className="w-4 h-4"/></Button>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Zone Modifiers</CardTitle>
                  <CardDescription>Dial in the comfort level for each specific zone (+/- from the master temp).</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    {entities.filter(e => e.domain === 'climate').length > 0 ? (
                      entities.filter(e => e.domain === 'climate').map(zone => {
                        const offset = climateSettings.zone_modifiers[zone.entity_id] || 0;
                        return (
                          <div key={zone.entity_id} className="flex flex-col md:flex-row md:items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-100 gap-4">
                            <div className="flex-1">
                              <p className="font-medium">{zone.friendly_name}</p>
                              <p className="text-xs text-slate-500">{zone.entity_id}</p>
                            </div>
                            
                            <div className="flex items-center gap-4">
                              <div className="flex items-center bg-white border border-slate-200 rounded-md">
                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-none rounded-l-md" onClick={() => handleZoneOffsetChange(zone.entity_id, -1)}><Minus className="w-3 h-3"/></Button>
                                <div className="w-12 text-center text-sm font-medium">
                                  {offset > 0 ? `+${offset}°` : `${offset}°`}
                                </div>
                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 rounded-none rounded-r-md" onClick={() => handleZoneOffsetChange(zone.entity_id, 1)}><Plus className="w-3 h-3"/></Button>
                              </div>
                            </div>

                            <div className="flex gap-3 text-xs text-slate-500 bg-white px-3 py-2 rounded border border-slate-200">
                              <div className="flex flex-col items-center">
                                <span className="font-semibold text-slate-700">{climateSettings.master_home + offset}°</span>
                                <span>Home</span>
                              </div>
                              <div className="w-px bg-slate-200"></div>
                              <div className="flex flex-col items-center">
                                <span className="font-semibold text-slate-700">{climateSettings.master_away + offset}°</span>
                                <span>Away</span>
                              </div>
                              <div className="w-px bg-slate-200"></div>
                              <div className="flex flex-col items-center">
                                <span className="font-semibold text-slate-700">{climateSettings.master_night + offset}°</span>
                                <span>Night</span>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-center py-8 text-slate-500">
                        No climate zones found. Connect Home Assistant to see your thermostats here.
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {activeTab === 'history' && (
            <Card>
              <CardHeader>
                <CardTitle>Device History</CardTitle>
                <CardDescription>Recent state changes pulled from Home Assistant</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-slate-500 uppercase bg-slate-50">
                      <tr>
                        <th className="px-6 py-3">Time</th>
                        <th className="px-6 py-3">Entity ID</th>
                        <th className="px-6 py-3">State</th>
                        <th className="px-6 py-3">Attributes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((item: any) => (
                        <tr key={item.id} className="border-b border-slate-100">
                          <td className="px-6 py-4">{new Date(item.last_changed + 'Z').toLocaleString()}</td>
                          <td className="px-6 py-4 font-medium">{item.entity_id}</td>
                          <td className="px-6 py-4">
                            <span className="px-2 py-1 bg-slate-100 rounded-md text-slate-700">
                              {item.state}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-slate-500 truncate max-w-xs">{item.attributes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === 'schedules' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-lg font-semibold">Rolling 14-Day Schedules</h2>
                  <p className="text-sm text-slate-500">Multi-zone predictive schedules based on inferred occupancy and patterns.</p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex bg-slate-200 p-1 rounded-lg">
                    <button 
                      onClick={() => setScheduleViewMode('calendar')}
                      className={`px-3 py-1 text-xs rounded-md transition-all ${scheduleViewMode === 'calendar' ? 'bg-white shadow-sm text-slate-900 font-medium' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Calendar
                    </button>
                    <button 
                      onClick={() => setScheduleViewMode('json')}
                      className={`px-3 py-1 text-xs rounded-md transition-all ${scheduleViewMode === 'json' ? 'bg-white shadow-sm text-slate-900 font-medium' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      JSON
                    </button>
                  </div>
                  <Button onClick={handleGenerateSchedule} disabled={isGenerating} className="bg-indigo-600 hover:bg-indigo-700">
                    {isGenerating ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2" />}
                    Generate New Schedule
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6">
                {schedules.map((schedule: any) => (
                  <Card key={schedule.id} className="overflow-hidden">
                    <CardHeader className="bg-white border-b border-slate-100">
                      <div className="flex justify-between items-start">
                        <div>
                          <CardTitle>{schedule.name}</CardTitle>
                          <CardDescription>{new Date(schedule.created_at + 'Z').toLocaleString()}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-6">
                      <p className="text-sm text-slate-600 mb-6">{schedule.description}</p>
                      
                      {scheduleViewMode === 'calendar' ? (
                        <div className="h-[600px]">
                          <ScheduleCalendar data={JSON.parse(schedule.schedule_data)} />
                        </div>
                      ) : (
                        <div className="bg-slate-900 rounded-xl p-6 overflow-auto max-h-[600px] border border-white/10">
                          <pre className="text-xs text-emerald-400 font-mono leading-relaxed">
                            {JSON.stringify(JSON.parse(schedule.schedule_data), null, 2)}
                          </pre>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
                {schedules.length === 0 && (
                  <div className="text-center py-24 bg-white rounded-2xl border border-dashed border-slate-200">
                    <Calendar className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                    <p className="text-slate-500 font-medium">No schedules generated yet.</p>
                    <p className="text-sm text-slate-400">Click "Generate New Schedule" to analyze your data.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'reasoning' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold">AI Reasoning & Decisions</h2>
                <p className="text-sm text-slate-500">Understand why the AI made specific scheduling decisions or real-time corrections.</p>
              </div>

              <div className="space-y-4">
                {reasoning.map((r: any) => (
                  <Card key={r.id}>
                    <CardHeader className="pb-2">
                      <div className="flex justify-between items-start">
                        <div>
                          <CardDescription className="text-indigo-600 font-medium mb-1">{r.context}</CardDescription>
                          <CardTitle className="text-lg">{r.decision}</CardTitle>
                        </div>
                        <span className="text-xs text-slate-400">{new Date(r.created_at + 'Z').toLocaleString()}</span>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-slate-700">{r.reasoning}</p>
                    </CardContent>
                  </Card>
                ))}
                {reasoning.length === 0 && (
                  <div className="text-center py-12 text-slate-500">
                    No reasoning data available yet. Run the daily analysis or wait for a real-time event.
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="max-w-4xl space-y-6">
              <div className="flex space-x-4 border-b border-slate-200 pb-2">
                <button 
                  onClick={() => setSettingsTab('general')}
                  className={`pb-2 text-sm font-medium transition-colors ${settingsTab === 'general' ? 'border-b-2 border-slate-900 text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  General Settings
                </button>
                {currentUser.role === 'admin' && (
                  <button 
                    onClick={() => setSettingsTab('api_keys')}
                    className={`pb-2 text-sm font-medium transition-colors ${settingsTab === 'api_keys' ? 'border-b-2 border-slate-900 text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}
                  >
                    API Keys & Logins
                  </button>
                )}
              </div>

              {settingsTab === 'general' && currentUser.role === 'admin' && (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle>AI Engine Tuning</CardTitle>
                      <CardDescription>Adjust how the AI analyzes your home and how often it makes decisions.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="ai_model">Gemini Model Selection</Label>
                          <select 
                            id="ai_model"
                            className="w-full p-2 border border-slate-200 rounded-md text-sm"
                            value={settings.ai_model}
                            onChange={e => setSettings({...settings, ai_model: e.target.value})}
                          >
                            <option value="gemini-3-flash-preview">Gemini 3 Flash (Fast & Efficient)</option>
                            <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Advanced Reasoning)</option>
                            <option value="gemini-2.5-flash-latest">Gemini 2.5 Flash (Legacy)</option>
                          </select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ai_realtime_interval">Real-Time Interval (Minutes: 1-60)</Label>
                          <div className="flex items-center gap-4">
                            <Input 
                              id="ai_realtime_interval" 
                              type="number" 
                              min="1" 
                              max="60"
                              value={settings.ai_realtime_interval}
                              onChange={e => setSettings({...settings, ai_realtime_interval: e.target.value})}
                            />
                            <span className="text-xs text-slate-500 whitespace-nowrap">Every {settings.ai_realtime_interval} mins</span>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ai_lookback_days">Lookback Window (Days: 7-30)</Label>
                          <div className="flex items-center gap-4">
                            <Input 
                              id="ai_lookback_days" 
                              type="number" 
                              min="7" 
                              max="30"
                              value={settings.ai_lookback_days}
                              onChange={e => setSettings({...settings, ai_lookback_days: e.target.value})}
                            />
                            <span className="text-xs text-slate-500 whitespace-nowrap">{settings.ai_lookback_days} days of history</span>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Climate Guardrails</CardTitle>
                      <CardDescription>Safety limits for AI-driven temperature adjustments.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="climate_abs_min">Absolute Minimum Temperature (°F)</Label>
                          <Input 
                            id="climate_abs_min" 
                            type="number" 
                            value={settings.climate_abs_min}
                            onChange={e => setSettings({...settings, climate_abs_min: e.target.value})}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="climate_abs_max">Absolute Maximum Temperature (°F)</Label>
                          <Input 
                            id="climate_abs_max" 
                            type="number" 
                            value={settings.climate_abs_max}
                            onChange={e => setSettings({...settings, climate_abs_max: e.target.value})}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>AI Learning & Knowledge Base</CardTitle>
                      <CardDescription>Pull in your existing Home Assistant logic to help the AI understand your preferences.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-lg flex items-start space-x-3">
                        <BrainCircuit className="w-5 h-5 text-indigo-600 mt-0.5" />
                        <div className="text-sm text-indigo-900">
                          <p className="font-medium">Automation & Script Sync</p>
                          <p className="opacity-80">The AI will analyze your existing automations to learn how you group actions (e.g., "Night Mode", "Away Mode") and what events you care about. It won't execute these, but will use them to better align its generated schedules with your intent.</p>
                        </div>
                      </div>
                      <Button 
                        onClick={handleSyncAutomationsScripts} 
                        disabled={isSyncing}
                        className="w-full bg-indigo-600 text-white hover:bg-indigo-700"
                      >
                        {isSyncing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                        Sync Automations & Scripts for AI Learning
                      </Button>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Data Management</CardTitle>
                      <CardDescription>Configure how data is synchronized and displayed.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="ai_context_window_hours">Context Sync Window (Hours: 1-24)</Label>
                          <Input 
                            id="ai_context_window_hours" 
                            type="number" 
                            min="1" 
                            max="24"
                            value={settings.ai_context_window_hours}
                            onChange={e => setSettings({...settings, ai_context_window_hours: e.target.value})}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="dashboard_default_timeframe">Graph Default Timeframe</Label>
                          <select 
                            id="dashboard_default_timeframe"
                            className="w-full p-2 border border-slate-200 rounded-md text-sm"
                            value={settings.dashboard_default_timeframe}
                            onChange={e => setSettings({...settings, dashboard_default_timeframe: e.target.value})}
                          >
                            <option value="24h">Last 24 Hours</option>
                            <option value="7d">Last 7 Days</option>
                            <option value="30d">Last 30 Days</option>
                          </select>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>AI Ghost Mode</CardTitle>
                      <CardDescription>When Ghost Mode is enabled, the AI will generate schedules and reasoning but will NOT send commands to Home Assistant.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div className="flex items-center justify-between p-4 bg-slate-50 border border-slate-100 rounded-lg">
                        <div>
                          <h4 className="font-medium text-slate-900">HVAC Ghost Mode</h4>
                          <p className="text-sm text-slate-500">Prevent AI from changing thermostat set points.</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="sr-only peer"
                            checked={settings.ghost_mode_hvac === 'true' || settings.ghost_mode_hvac === undefined}
                            onChange={(e) => handleUpdateSingleSetting('ghost_mode_hvac', e.target.checked ? 'true' : 'false')}
                          />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                        </label>
                      </div>

                      <div className="flex items-center justify-between p-4 bg-slate-50 border border-slate-100 rounded-lg">
                        <div>
                          <h4 className="font-medium text-slate-900">Whole Home AI Ghost Mode</h4>
                          <p className="text-sm text-slate-500">Prevent AI from controlling lights, switches, and whole-home modes (Sleep, Away, Home).</p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input 
                            type="checkbox" 
                            className="sr-only peer"
                            checked={settings.ghost_mode_whole_home === 'true' || settings.ghost_mode_whole_home === undefined}
                            onChange={(e) => handleUpdateSingleSetting('ghost_mode_whole_home', e.target.checked ? 'true' : 'false')}
                          />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                        </label>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Dashboard Graph Zones</CardTitle>
                      <CardDescription>Select which climate zones to display on the dashboard temperature graph.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-60 overflow-y-auto">
                        {entities.filter(e => e.domain === 'climate').map(zone => (
                          <label key={zone.entity_id} className="flex items-center space-x-3 p-3 border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50">
                            <input 
                              type="checkbox" 
                              className="w-4 h-4 text-slate-900 rounded border-slate-300 focus:ring-slate-900"
                              checked={JSON.parse(settings.dashboard_graph_zones || '[]').includes(zone.entity_id)}
                              onChange={() => handleToggleGraphZone(zone.entity_id)}
                            />
                            <span className="text-sm font-medium text-slate-700">{zone.friendly_name}</span>
                          </label>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>AI Context Notes</CardTitle>
                      <CardDescription>Provide manual context to the AI (e.g., "I will be out of work next Tuesday", "We have guests this weekend").</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <textarea
                          className="w-full min-h-[100px] p-3 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-slate-900 focus:border-transparent outline-none resize-y"
                          placeholder="Add any upcoming events, schedule changes, or context the AI should know about..."
                          value={settings.user_ai_context}
                          onChange={e => setSettings({...settings, user_ai_context: e.target.value})}
                        />
                        <Button onClick={handleSaveSettings} className="bg-slate-900 text-white hover:bg-slate-800">Save Context</Button>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>User Management</CardTitle>
                      <CardDescription>Manage access to HomeBrain AI.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-6">
                        <form onSubmit={handleAddUser} className="flex items-end gap-4 bg-slate-50 p-4 rounded-lg border border-slate-100">
                          <div className="space-y-2 flex-1">
                            <Label htmlFor="new_username">Username</Label>
                            <Input id="new_username" value={newUser.username} onChange={e => setNewUser({...newUser, username: e.target.value})} required />
                          </div>
                          <div className="space-y-2 flex-1">
                            <Label htmlFor="new_password">Password</Label>
                            <Input id="new_password" type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} required />
                          </div>
                          <div className="space-y-2 w-32">
                            <Label htmlFor="new_role">Role</Label>
                            <select 
                              id="new_role" 
                              className="w-full h-10 px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
                              value={newUser.role} 
                              onChange={e => setNewUser({...newUser, role: e.target.value})}
                            >
                              <option value="viewer">Viewer</option>
                              <option value="admin">Admin</option>
                            </select>
                          </div>
                          <Button type="submit" className="bg-slate-900 text-white hover:bg-slate-800"><UserPlus className="w-4 h-4 mr-2"/> Add</Button>
                        </form>

                        <div className="border border-slate-200 rounded-lg overflow-hidden">
                          <table className="w-full text-sm text-left">
                            <thead className="bg-slate-50 border-b border-slate-200">
                              <tr>
                                <th className="px-4 py-3 font-medium text-slate-700">Username</th>
                                <th className="px-4 py-3 font-medium text-slate-700">Role</th>
                                <th className="px-4 py-3 font-medium text-slate-700 text-right">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200">
                              {usersList.map(user => (
                                <tr key={user.id} className="bg-white">
                                  <td className="px-4 py-3 font-medium">{user.username}</td>
                                  <td className="px-4 py-3 capitalize">
                                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${user.role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-700'}`}>
                                      {user.role}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-right">
                                    <Button variant="ghost" size="sm" onClick={() => handleDeleteUser(user.id)} disabled={user.username === 'admin'} className="text-rose-600 hover:text-rose-700 hover:bg-rose-50">
                                      <Trash2 className="w-4 h-4" />
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>System Updates & Maintenance</CardTitle>
                      <CardDescription>
                        Check for application updates and verify system integrity. 
                        Note: Database data is stored in a persistent volume and is NOT overwritten during system updates.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="space-y-1">
                            <p className="text-sm font-medium">Application Version</p>
                            <p className="text-xs text-slate-500">Current Version: v1.0.4 (Stable)</p>
                          </div>
                          <div className="flex gap-2">
                            <Button 
                              onClick={handleCheckUpdate} 
                              disabled={updateStatus.checking || updateStatus.updating} 
                              variant="outline"
                              className="border-slate-200"
                            >
                              {updateStatus.checking ? (
                                <>
                                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                                  Checking...
                                </>
                              ) : (
                                <>
                                  <ArrowUpCircle className="w-4 h-4 mr-2" />
                                  Check for Updates
                                </>
                              )}
                            </Button>
                            {updateStatus.available && (
                              <Button 
                                onClick={handleApplyUpdate} 
                                disabled={updateStatus.updating} 
                                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                              >
                                {updateStatus.updating ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
                                {updateStatus.updating ? 'Updating...' : 'Apply Update'}
                              </Button>
                            )}
                          </div>
                        </div>
                        
                        {updateStatus.message && (
                          <div className={`p-3 rounded-lg text-sm flex items-start gap-3 ${updateStatus.available ? 'bg-blue-50 text-blue-700 border border-blue-100' : 'bg-slate-50 text-slate-700 border border-slate-100'}`}>
                            <Info className="w-4 h-4 text-indigo-600 mt-0.5" />
                            <p className="text-xs">{updateStatus.message}</p>
                          </div>
                        )}

                        <div className="pt-4 border-t border-slate-100">
                          <div className="flex items-center gap-2 text-xs text-emerald-600 font-medium">
                            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                            Database Persistent Storage: Active
                          </div>
                          <p className="text-[10px] text-slate-400 mt-1">
                            Your local SQLite database (home_brain.db) is excluded from build overwrites and will persist across all application updates, including redeployments via the AI Studio Update button.
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Historical Data Sync</CardTitle>
                      <CardDescription>
                        Perform a phased pull of historical data from Home Assistant. 
                        This is done in a "slow staged" way (500ms delay per entity) to avoid overloading your Home Assistant instance.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="space-y-1">
                            <p className="text-sm font-medium">Phased History Pull</p>
                            <p className="text-xs text-slate-500">
                              Pull the last {settings.ai_lookback_days} days of history for all tracked entities.
                            </p>
                          </div>
                          <Button 
                            onClick={handleHistorySync} 
                            disabled={isSyncing}
                            className={isSyncing ? "bg-slate-100 text-slate-400" : "bg-indigo-600 text-white hover:bg-indigo-700"}
                          >
                            {isSyncing ? (
                              <>
                                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                                Syncing...
                              </>
                            ) : (
                              <>
                                <RefreshCw className="w-4 h-4 mr-2" />
                                Start Phased Sync
                              </>
                            )}
                          </Button>
                        </div>

                        {isSyncing && (
                          <div className="space-y-2">
                            <div className="flex justify-between text-xs font-medium text-slate-500">
                              <span>{syncProgress.entity}</span>
                              <span>{syncProgress.progress}%</span>
                            </div>
                            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                              <div 
                                className="bg-indigo-600 h-full transition-all duration-500" 
                                style={{ width: `${syncProgress.progress}%` }}
                              ></div>
                            </div>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>AI System Context Sync</CardTitle>
                      <CardDescription>Pull all entity information, system config, and targeted history to provide the AI with a complete understanding of your Home Assistant environment.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <p className="text-sm text-slate-500">
                          This process syncs every entity, state, and attribute, along with core system setup and recent history for climate, weather, and sensors. 
                          This data is stored internally to help the AI explicitly know entity variables and determine what to watch for climate automation.
                        </p>
                        <Button 
                          onClick={handleSyncSystemData} 
                          disabled={isSyncing}
                          className="bg-indigo-600 text-white hover:bg-indigo-700"
                        >
                          {isSyncing ? (
                            <>
                              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                              Syncing Data...
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-4 h-4 mr-2" />
                              Sync System Data for AI
                            </>
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}

              {settingsTab === 'api_keys' && currentUser.role === 'admin' && (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle>Home Assistant Connection</CardTitle>
                      <CardDescription>Configure your connection to Home Assistant.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <form onSubmit={handleSaveSettings} className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="ha_url">Home Assistant URL</Label>
                            <Input 
                              id="ha_url" 
                              placeholder="http://homeassistant.local:8123" 
                              value={settings.ha_url || ''}
                              onChange={e => setSettings({...settings, ha_url: e.target.value})}
                            />
                            {settings.ha_url?.includes('.local') && (
                              <p className="text-[10px] text-amber-600 mt-1">
                                Warning: .local addresses are not reachable from the cloud. Use a public URL or Nabu Casa.
                              </p>
                            )}
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="ha_token">Long-Lived Access Token</Label>
                            <Input 
                              id="ha_token" 
                              type="password" 
                              autoComplete="new-password"
                              value={settings.ha_token || ''}
                              onChange={e => setSettings({...settings, ha_token: e.target.value})}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-4 pt-2">
                          <Button type="submit" className="bg-slate-900 text-white hover:bg-slate-800">Save Connection</Button>
                          <Button 
                            type="button" 
                            variant="outline" 
                            onClick={handleForceConnect}
                            disabled={haStatus.status === 'connecting'}
                          >
                            {haStatus.status === 'connecting' ? 'Connecting...' : 'Force Reconnect'}
                          </Button>
                        </div>
                      </form>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle>Telegram Notifications</CardTitle>
                      <CardDescription>Configure Telegram for alerts and notifications.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <form onSubmit={handleSaveSettings} className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="telegram_bot_token">Bot Token</Label>
                            <Input 
                              id="telegram_bot_token" 
                              type="password" 
                              autoComplete="new-password"
                              placeholder="123456789:ABCdef..." 
                              value={settings.telegram_bot_token || ''}
                              onChange={e => setSettings({...settings, telegram_bot_token: e.target.value})}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="telegram_chat_id">Chat ID</Label>
                            <Input 
                              id="telegram_chat_id" 
                              type="text" 
                              placeholder="-1001234567890" 
                              value={settings.telegram_chat_id || ''}
                              onChange={e => setSettings({...settings, telegram_chat_id: e.target.value})}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-4 pt-2">
                          <Button type="submit" className="bg-slate-900 text-white hover:bg-slate-800">Save Telegram Settings</Button>
                        </div>
                      </form>
                    </CardContent>
                  </Card>
                </>
              )}

              <Card>
                <CardHeader>
                  <div className="flex justify-between items-center">
                    <div>
                      <CardTitle>Tracked Devices & Roles</CardTitle>
                      <CardDescription>Select devices to track and add notes to help the AI understand their purpose.</CardDescription>
                    </div>
                    <Button 
                      onClick={handleAIScan} 
                      disabled={isScanning || haStatus.status !== 'connected'}
                      variant="outline"
                      className="border-indigo-200 text-indigo-700 hover:bg-indigo-50"
                    >
                      {isScanning ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Scan className="w-4 h-4 mr-2" />}
                      AI Scan for Entities
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {scanResults.length > 0 && (
                    <div className="mb-6 p-4 bg-indigo-50 border border-indigo-100 rounded-xl space-y-4">
                      <div className="flex justify-between items-center">
                        <h4 className="text-sm font-semibold text-indigo-900 flex items-center">
                          <BrainCircuit className="w-4 h-4 mr-2" />
                          AI Recommended Entities ({scanResults.length})
                        </h4>
                        <div className="flex gap-2">
                          <Button 
                            size="sm" 
                            variant="ghost" 
                            onClick={() => setScanResults([])}
                            className="text-indigo-600 hover:bg-indigo-100"
                          >
                            Dismiss
                          </Button>
                          <Button 
                            size="sm" 
                            onClick={() => handleBulkTrack(scanResults.map(s => ({ entity_id: s.entity_id, notes: s.reason })))}
                            className="bg-indigo-600 text-white hover:bg-indigo-700"
                          >
                            <CheckCircle className="w-4 h-4 mr-2" />
                            Track All Recommended
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {scanResults.map(result => (
                          <div key={result.entity_id} className="text-xs p-2 bg-white rounded border border-indigo-100 flex justify-between items-center">
                            <div>
                              <span className="font-mono font-bold text-indigo-900">{result.entity_id}</span>
                              <p className="text-slate-500 italic">{result.reason}</p>
                            </div>
                            {!trackedEntities[result.entity_id]?.tracked && (
                              <Button 
                                size="sm" 
                                variant="ghost" 
                                className="h-6 px-2 text-indigo-600"
                                onClick={() => handleBulkTrack([{ entity_id: result.entity_id, notes: result.reason }])}
                              >
                                Track
                              </Button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="space-y-4 mb-4">
                    <div className="flex flex-wrap gap-2 mb-4">
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="text-xs"
                        onClick={() => {
                          const climate = entities.filter(e => e.domain === 'climate' || e.domain === 'person' || e.domain === 'device_tracker');
                          handleBulkTrack(climate.map(e => ({ entity_id: e.entity_id, notes: `Auto-tracked ${e.domain}` })));
                        }}
                      >
                        <Zap className="w-3 h-3 mr-1" /> Track All Climate & Presence
                      </Button>
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="text-xs"
                        onClick={() => {
                          const temps = entities.filter(e => e.entity_id.includes('temperature'));
                          handleBulkTrack(temps.map(e => ({ entity_id: e.entity_id, notes: 'Auto-tracked temperature sensor' })));
                        }}
                      >
                        <Thermometer className="w-3 h-3 mr-1" /> Track All Temp Sensors
                      </Button>
                    </div>
                    <div className="flex flex-col md:flex-row gap-3">
                      <div className="flex-1">
                        <Input 
                          placeholder="Search devices by name or ID..." 
                          value={deviceSearch}
                          onChange={(e) => setDeviceSearch(e.target.value)}
                        />
                      </div>
                      <select 
                        className="h-10 px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                        value={deviceTypeFilter}
                        onChange={(e) => setDeviceTypeFilter(e.target.value)}
                      >
                        <option value="all">All Types</option>
                        {uniqueDomains.map(domain => (
                          <option key={domain as string} value={domain as string}>{domain}</option>
                        ))}
                      </select>
                      <select 
                        className="h-10 px-3 py-2 border border-slate-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                        value={deviceStatusFilter}
                        onChange={(e) => setDeviceStatusFilter(e.target.value)}
                      >
                        <option value="all">All Statuses</option>
                        <option value="tracked">Tracked Only</option>
                        <option value="untracked">Untracked Only</option>
                      </select>
                    </div>
                  </div>

                  <div className="max-h-96 overflow-y-auto space-y-4 pr-4">
                    {filteredEntities.length > 0 ? filteredEntities.map(entity => (
                      <div key={entity.entity_id} className="flex flex-col space-y-2 p-3 bg-slate-50 rounded-lg border border-slate-100">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium text-sm">{entity.friendly_name}</p>
                            <p className="text-xs text-slate-500">{entity.entity_id}</p>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input 
                              type="checkbox" 
                              className="sr-only peer"
                              checked={trackedEntities[entity.entity_id]?.tracked || false}
                              onChange={(e) => handleToggleTracked(entity.entity_id, e.target.checked, trackedEntities[entity.entity_id]?.notes || '')}
                            />
                            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                          </label>
                        </div>
                        {trackedEntities[entity.entity_id]?.tracked && (
                          <Input 
                            placeholder="Add a role or note (e.g., 'Zone 1', 'Anthony\\'s Phone')" 
                            className="h-8 text-xs"
                            value={trackedEntities[entity.entity_id]?.notes || ''}
                            onChange={(e) => handleUpdateNotes(entity.entity_id, e.target.value)}
                          />
                        )}
                      </div>
                    )) : (
                      <div className="text-sm text-slate-500 text-center py-8 bg-slate-50 rounded-lg border border-dashed border-slate-200">
                        {entities.length === 0 ? "No entities found. Check your HA connection." : "No devices match your search/filter criteria."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Installation Guide</CardTitle>
                  <CardDescription>How to install this on an Ubuntu Server.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="bg-[#0a0a0a] text-slate-300 p-4 rounded-lg text-sm font-mono overflow-x-auto border border-white/10">
                    <p># 1. Install Node.js and PM2</p>
                    <p>curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -</p>
                    <p>sudo apt-get install -y nodejs</p>
                    <p>sudo npm install -g pm2</p>
                    <br/>
                    <p># 2. Clone repository and install dependencies</p>
                    <p>git clone https://github.com/cstone1983/AI-Climate-Brain.git homebrain</p>
                    <p>cd homebrain</p>
                    <p>npm install</p>
                    <br/>
                    <p># 3. Build the application</p>
                    <p>npm run build</p>
                    <br/>
                    <p># 4. Start with PM2</p>
                    <p>pm2 start npm --name "homebrain" -- run start</p>
                    <p>pm2 save</p>
                    <p>pm2 startup</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

