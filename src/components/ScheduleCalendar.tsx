import React, { useState } from 'react';
import { Clock, Info, ChevronLeft, ChevronRight } from 'lucide-react';

interface ScheduleEvent {
  time: string;
  action: string;
  reasoning: string;
  day?: string;
  date?: string;
}

interface ScheduleCalendarProps {
  data: ScheduleEvent[];
}

export function ScheduleCalendar({ data = [] }: ScheduleCalendarProps) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  if (!Array.isArray(data)) {
    return (
      <div className="p-4 bg-red-50 text-red-600 rounded-xl border border-red-100 text-sm">
        Invalid schedule data format.
      </div>
    );
  }

  // Group events by day if day/date exists
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

  const hours = Array.from({ length: 24 }, (_, i) => i);

  const handlePrevDay = () => {
    const idx = days.indexOf(currentDay);
    if (idx > 0) setSelectedDay(days[idx - 1]);
  };

  const handleNextDay = () => {
    const idx = days.indexOf(currentDay);
    if (idx < days.length - 1) setSelectedDay(days[idx + 1]);
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header / Day Selector */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-400" />
          <h3 className="font-semibold text-slate-700">{currentDay}</h3>
        </div>
        
        {days.length > 1 && (
          <div className="flex items-center gap-1">
            <button 
              onClick={handlePrevDay}
              disabled={days.indexOf(currentDay) === 0}
              className="p-1 hover:bg-slate-200 rounded disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-medium text-slate-500 px-2">
              {days.indexOf(currentDay) + 1} / {days.length}
            </span>
            <button 
              onClick={handleNextDay}
              disabled={days.indexOf(currentDay) === days.length - 1}
              className="p-1 hover:bg-slate-200 rounded disabled:opacity-30 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Calendar Grid */}
      <div className="flex-1 overflow-y-auto relative min-h-[400px]">
        <div className="grid grid-cols-[60px_1fr] min-h-full">
          {/* Time Labels */}
          <div className="border-r border-slate-100 bg-slate-50/30">
            {hours.map(hour => (
              <div key={hour} className="h-20 border-b border-slate-100 px-2 py-2 text-[10px] text-slate-400 font-medium text-right">
                {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
              </div>
            ))}
          </div>

          {/* Grid Lines & Events */}
          <div className="relative bg-white">
            {hours.map(hour => (
              <div key={hour} className="h-20 border-b border-slate-100" />
            ))}

            {/* Events */}
            {events.map((event, idx) => {
              // Parse time (HH:mm)
              const timeParts = event.time?.match(/(\d+):(\d+)/);
              if (!timeParts) return null;
              
              const h = parseInt(timeParts[1]);
              const m = parseInt(timeParts[2]);
              const top = (h * 80) + (m / 60 * 80);

              return (
                <div 
                  key={idx}
                  className="absolute left-2 right-4 p-3 bg-indigo-50 border-l-4 border-indigo-500 rounded-lg shadow-sm group hover:shadow-md hover:bg-indigo-100 transition-all z-10 hover:z-20"
                  style={{ top: `${top}px`, minHeight: '60px' }}
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">{event.time}</span>
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                      <Info className="w-3 h-3 text-indigo-400" />
                    </div>
                  </div>
                  <p className="text-xs font-semibold text-slate-800 leading-tight">{event.action}</p>
                  
                  {/* Tooltip-like reasoning */}
                  <div className="hidden group-hover:block absolute left-0 top-full mt-2 w-full max-w-xs p-3 bg-slate-900 text-white text-[11px] rounded-xl shadow-2xl z-50 border border-white/10">
                    <p className="font-bold mb-1 text-indigo-300">AI Reasoning:</p>
                    {event.reasoning}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
