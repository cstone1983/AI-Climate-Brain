import React, { useState } from 'react';
import { Clock, Info, ChevronLeft, ChevronRight, Sun, Sunrise, Sunset, Moon, Coffee, Briefcase, GraduationCap, Home, User, BrainCircuit } from 'lucide-react';

interface ScheduleEvent {
  time: string;
  action: string;
  reasoning: string;
  day?: string;
  date?: string;
  label?: string; // Optional label like "Morning Wakeup"
  entity_id?: string;
  state?: string;
  evidence?: string;
}

interface RoutineTimelineProps {
  data: ScheduleEvent[];
}

export function RoutineTimeline({ data = [] }: RoutineTimelineProps) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  if (!Array.isArray(data)) {
    return (
      <div className="p-4 bg-red-50 text-red-600 rounded-xl border border-red-100 text-sm">
        Invalid schedule data format.
      </div>
    );
  }

  // Group events by day
  const groupedData: Record<string, ScheduleEvent[]> = {};
  
  if (data.length > 0 && (data[0].day || data[0].date)) {
    data.forEach(event => {
      const key = event.day || event.date || 'Today';
      if (!groupedData[key]) groupedData[key] = [];
      groupedData[key].push(event);
    });
  } else {
    groupedData['Today'] = data;
  }

  const days = Object.keys(groupedData);
  const currentDay = selectedDay || days[0];
  const events = groupedData[currentDay] || [];

  // Sort events by time
  const sortedEvents = [...events].sort((a, b) => {
    const timeA = a.time || '00:00';
    const timeB = b.time || '00:00';
    return timeA.localeCompare(timeB);
  });

  const handlePrevDay = () => {
    const idx = days.indexOf(currentDay);
    if (idx > 0) setSelectedDay(days[idx - 1]);
  };

  const handleNextDay = () => {
    const idx = days.indexOf(currentDay);
    if (idx < days.length - 1) setSelectedDay(days[idx + 1]);
  };

  // Helper to get icon based on time/action
  const getEventIcon = (time: string, action: string) => {
    const hour = time ? parseInt(time.split(':')[0]) : 12;
    const lowerAction = (action || '').toLowerCase();

    if (lowerAction.includes('wakeup') || (hour >= 5 && hour < 8)) return <Sunrise className="w-5 h-5 text-orange-500" />;
    if (lowerAction.includes('coffee') || lowerAction.includes('breakfast')) return <Coffee className="w-5 h-5 text-amber-600" />;
    if (lowerAction.includes('school') || lowerAction.includes('kids')) return <GraduationCap className="w-5 h-5 text-blue-500" />;
    if (lowerAction.includes('work') || lowerAction.includes('office')) return <Briefcase className="w-5 h-5 text-slate-600" />;
    if (lowerAction.includes('return') || lowerAction.includes('home')) return <Home className="w-5 h-5 text-emerald-500" />;
    if (lowerAction.includes('chris')) return <User className="w-5 h-5 text-indigo-500" />;
    if (hour >= 8 && hour < 17) return <Sun className="w-5 h-5 text-yellow-500" />;
    if (hour >= 17 && hour < 20) return <Sunset className="w-5 h-5 text-orange-600" />;
    return <Moon className="w-5 h-5 text-indigo-400" />;
  };

  // Helper to get a friendly label if missing
  const getFriendlyLabel = (event: ScheduleEvent) => {
    if (event.label) return event.label;
    
    const hour = event.time ? parseInt(event.time.split(':')[0]) : 12;
    const action = (event.action || '').toLowerCase();

    if (action.includes('wakeup')) return "Morning Wakeup";
    if (action.includes('school')) return "School Departure";
    if (action.includes('work')) return "Work Start";
    if (action.includes('return') && action.includes('kids')) return "Kids Return";
    if (action.includes('return') && action.includes('chris')) return "Chris Returns";
    if (hour >= 21 || action.includes('night') || action.includes('sleep')) return "Night Mode";
    if (hour < 12) return "Morning Routine";
    if (hour < 17) return "Daytime Activity";
    return "Evening Routine";
  };

  const [expandedReasoning, setExpandedReasoning] = useState<Record<number, boolean>>({});

  const toggleReasoning = (idx: number) => {
    setExpandedReasoning(prev => ({ ...prev, [idx]: !prev[idx] }));
  };

  return (
    <div className="flex flex-col space-y-6">
      {/* Day Selector */}
      <div className="flex items-center justify-between bg-slate-100/50 p-2 rounded-xl border border-slate-200">
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={handlePrevDay}
          disabled={days.indexOf(currentDay) === 0}
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Prev
        </Button>
        
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-indigo-600" />
          <span className="font-bold text-slate-800">{currentDay}</span>
        </div>

        <Button 
          variant="ghost" 
          size="sm" 
          onClick={handleNextDay}
          disabled={days.indexOf(currentDay) === days.length - 1}
        >
          Next
          <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>

      {/* Timeline Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sortedEvents.map((event, idx) => (
          <div key={idx} className="group relative bg-white border border-slate-200 rounded-2xl p-5 hover:border-indigo-300 hover:shadow-md transition-all">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-slate-50 rounded-xl group-hover:bg-indigo-50 transition-colors">
                  {getEventIcon(event.time, event.action)}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-slate-900 leading-tight truncate">{getFriendlyLabel(event)}</h4>
                  <span className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{event.time || 'TBD'}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => toggleReasoning(idx)}
                  className={`p-1.5 rounded-lg transition-all ${expandedReasoning[idx] ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'}`}
                  title="Show AI Reasoning"
                >
                  <BrainCircuit className="w-4 h-4" />
                </button>
                <div className="relative group/info">
                  <button className="p-1.5 text-slate-300 hover:text-slate-500 transition-colors">
                    <Info className="w-4 h-4" />
                  </button>
                  <div className="hidden group-hover/info:block absolute right-0 top-full mt-2 w-64 p-3 bg-slate-900 text-white text-[10px] rounded-xl shadow-2xl z-50 border border-white/10">
                    <p className="font-bold mb-1 text-indigo-300 uppercase tracking-wider">Technical Details</p>
                    <div className="space-y-1 opacity-80">
                      <p><span className="text-slate-400">Entity:</span> {event.entity_id || 'N/A'}</p>
                      <p><span className="text-slate-400">Target State:</span> {event.state || 'N/A'}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <p className="text-sm text-slate-600 mb-3">
              {event.action || 'No action description provided.'}
            </p>

            {expandedReasoning[idx] && (
              <div className="mt-3 p-3 bg-indigo-50/50 rounded-xl border border-indigo-100 animate-in fade-in slide-in-from-top-1 duration-200">
                <div className="flex items-center gap-2 mb-1.5">
                  <BrainCircuit className="w-3.5 h-3.5 text-indigo-600" />
                  <span className="text-[10px] font-bold text-indigo-800 uppercase tracking-wider">AI Reasoning</span>
                </div>
                <p className="text-xs text-slate-700 leading-relaxed italic mb-2">
                  "{event.reasoning || 'The AI did not provide specific reasoning for this event.'}"
                </p>
                {event.evidence && (
                  <div className="mt-2 pt-2 border-t border-indigo-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Evidence / Source Data</p>
                    <p className="text-[11px] text-indigo-900 font-medium bg-white/50 p-1.5 rounded-lg border border-indigo-50/50">
                      {event.evidence}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Connecting line for visual flow (only on desktop) */}
            {idx < sortedEvents.length - 1 && (
              <div className="hidden lg:block absolute -right-2 top-1/2 w-4 h-px bg-slate-200 z-0" />
            )}
          </div>
        ))}

        {sortedEvents.length === 0 && (
          <div className="col-span-full py-12 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-300">
            <p className="text-slate-400 italic">No events scheduled for this day.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Internal Button component to avoid dependency issues if needed, but we have it in App.tsx
function Button({ children, variant, size, onClick, disabled, className }: any) {
  const baseStyles = "inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";
  const variants = {
    ghost: "hover:bg-slate-100 text-slate-600",
    outline: "border border-slate-200 bg-white hover:bg-slate-50 text-slate-600"
  };
  const sizes = {
    sm: "h-8 px-3 text-xs",
    md: "h-10 px-4 py-2 text-sm"
  };

  return (
    <button 
      onClick={onClick} 
      disabled={disabled}
      className={`${baseStyles} ${(variants as any)[variant || 'outline']} ${(sizes as any)[size || 'md']} ${className}`}
    >
      {children}
    </button>
  );
}
