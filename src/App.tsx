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
  Trash2
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from './components/ui/card';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isSidebarOpen, setSidebarOpen] = useState(true);
  const [currentUser, setCurrentUser] = useState<{id: number, username: string, role: string} | null>(null);
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  
  const [settings, setSettings] = useState({
    ha_url: '',
    ha_token: '',
    user_ai_context: '',
    dashboard_graph_zones: '[]'
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
  const [haStatus, setHaStatus] = useState('disconnected');
  const [usersList, setUsersList] = useState<any[]>([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'viewer' });
  const [updateStatus, setUpdateStatus] = useState({ checking: false, available: false, message: '', updating: false });
  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceTypeFilter, setDeviceTypeFilter] = useState('all');
  const [deviceStatusFilter, setDeviceStatusFilter] = useState('all');

  useEffect(() => {
    if (currentUser) {
      fetchSettings();
      fetchHistory();
      fetchSchedules();
      fetchInsights();
      fetchReasoning();
      fetchEntities();
      fetchHaStatus();
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
            fetchGraphData(settings.dashboard_graph_zones);
          }
        } else if (message.type === 'NEW_REASONING') {
          fetchReasoning();
          fetchSchedules();
        } else if (message.type === 'HA_STATUS') {
          setHaStatus(message.status);
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
    setHaStatus(data.status);
  };

  const handleForceConnect = async () => {
    setHaStatus('connecting');
    await fetch('/api/ha/force-connect', { method: 'POST' });
    fetchHaStatus();
  };

  const fetchUsers = async () => {
    const res = await fetch('/api/users');
    const data = await res.json();
    setUsersList(data);
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
    setSettings(data);
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
      const res = await fetch('/api/ai/trigger-daily-analysis', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert('Daily analysis started in background. Check back soon for new schedules and insights.');
      } else {
        alert('Failed to start analysis: ' + data.error);
      }
    } catch (e) {
      alert('Error starting analysis');
    }
    setIsGenerating(false);
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
      const date = new Date(item.last_changed + 'Z');
      
      let timeKey = '';
      if (graphTimeframe === '24h') {
        timeKey = `${date.getHours().toString().padStart(2, '0')}:00`;
      } else if (graphTimeframe === '7d' || graphTimeframe === '30d') {
        timeKey = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:00`;
      } else {
        timeKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
      }
      
      if (!chartDataMap[timeKey]) {
        chartDataMap[timeKey] = { time: timeKey, timestamp: date.getTime() };
      }
      
      try {
        const attrs = JSON.parse(item.attributes);
        if (attrs.current_temperature) {
          chartDataMap[timeKey][item.entity_id] = attrs.current_temperature;
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
            <div className={`flex items-center px-3 py-1.5 rounded-full text-xs font-medium border ${haStatus === 'connected' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : haStatus === 'connecting' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
              {haStatus === 'connected' ? <Wifi className="w-3.5 h-3.5 mr-1.5" /> : <WifiOff className="w-3.5 h-3.5 mr-1.5" />}
              {haStatus === 'connected' ? 'HA Connected' : haStatus === 'connecting' ? 'Connecting...' : 'HA Disconnected'}
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
                        <XAxis dataKey="time" stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                        <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} domain={['dataMin - 2', 'dataMax + 2']} />
                        <Tooltip 
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
                <Button onClick={handleGenerateSchedule} disabled={isGenerating} className="bg-indigo-600 hover:bg-indigo-700">
                  {isGenerating ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2" />}
                  Generate New Schedule
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {schedules.map((schedule: any) => (
                  <Card key={schedule.id}>
                    <CardHeader>
                      <CardTitle>{schedule.name}</CardTitle>
                      <CardDescription>{new Date(schedule.created_at + 'Z').toLocaleString()}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-slate-600 mb-4">{schedule.description}</p>
                      <div className="bg-slate-900 rounded-lg p-4 overflow-auto max-h-48">
                        <pre className="text-xs text-green-400 font-mono">
                          {JSON.stringify(JSON.parse(schedule.schedule_data), null, 2)}
                        </pre>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {schedules.length === 0 && (
                  <div className="col-span-2 text-center py-12 text-slate-500">
                    No schedules generated yet. Click the button above to analyze your data.
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
              {currentUser.role === 'admin' && (
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
                              value={settings.ha_url}
                              onChange={e => setSettings({...settings, ha_url: e.target.value})}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="ha_token">Long-Lived Access Token</Label>
                            <Input 
                              id="ha_token" 
                              type="password" 
                              value={settings.ha_token}
                              onChange={e => setSettings({...settings, ha_token: e.target.value})}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-4 pt-2">
                          <Button type="submit" className="bg-slate-900 text-white hover:bg-slate-800">Save Connection</Button>
                          <Button type="button" variant="outline" onClick={handleForceConnect}>Force Reconnect</Button>
                        </div>
                      </form>
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
                      <CardTitle>System Updates</CardTitle>
                      <CardDescription>Check for and apply updates from the GitHub repository.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="flex items-center gap-4">
                          <Button onClick={handleCheckUpdate} disabled={updateStatus.checking || updateStatus.updating} variant="outline">
                            {updateStatus.checking ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                            Check for Updates
                          </Button>
                          {updateStatus.available && (
                            <Button onClick={handleApplyUpdate} disabled={updateStatus.updating} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                              {updateStatus.updating ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
                              {updateStatus.updating ? 'Updating...' : 'Apply Update'}
                            </Button>
                          )}
                        </div>
                        {updateStatus.message && (
                          <div className={`p-3 rounded-lg text-sm ${updateStatus.available ? 'bg-blue-50 text-blue-700 border border-blue-100' : 'bg-slate-50 text-slate-700 border border-slate-100'}`}>
                            {updateStatus.message}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}

              <Card>
                <CardHeader>
                  <CardTitle>Tracked Devices & Roles</CardTitle>
                  <CardDescription>Select devices to track and add notes (e.g., "Anthony's Phone", "Zone 1 Heating") to help the AI understand their purpose.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4 mb-4">
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

