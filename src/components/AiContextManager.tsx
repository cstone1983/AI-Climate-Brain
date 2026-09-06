import React, { useState } from 'react';
import { Edit2, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';

interface AiContextManagerProps {
  userAiContext: string;
  onUpdate: (newContext: string) => void;
}

export const AiContextManager: React.FC<AiContextManagerProps> = ({ userAiContext, onUpdate }) => {
  const [newAiContextNote, setNewAiContextNote] = useState('');
  const [editingAiContextNoteId, setEditingAiContextNoteId] = useState<string | null>(null);
  const [editingAiContextNoteText, setEditingAiContextNoteText] = useState('');

  const getAiContextNotes = () => {
    if (!userAiContext || !userAiContext.trim()) return [];
    try {
      const parsed = JSON.parse(userAiContext);
      if (Array.isArray(parsed)) return parsed;
      // Valid JSON but not an array (e.g. a bare string/number) - treat as a single legacy note.
      return [{ id: Date.now().toString(), text: userAiContext }];
    } catch (e) {
      // Not JSON at all - legacy plain-text context, migrate it into a single note.
      return [{ id: Date.now().toString(), text: userAiContext }];
    }
  };

  const handleAddAiContextNote = () => {
    if (!newAiContextNote.trim()) return;
    const notes = getAiContextNotes();
    const newNotes = [...notes, { id: Date.now().toString(), text: newAiContextNote.trim() }];
    const newContextString = JSON.stringify(newNotes);
    onUpdate(newContextString);
    setNewAiContextNote('');
  };

  const handleDeleteAiContextNote = (id: string) => {
    const notes = getAiContextNotes();
    const newNotes = notes.filter((n: any) => n.id !== id);
    const newContextString = JSON.stringify(newNotes);
    onUpdate(newContextString);
  };

  const handleStartEditAiContextNote = (id: string, text: string) => {
    setEditingAiContextNoteId(id);
    setEditingAiContextNoteText(text);
  };

  const handleSaveEditAiContextNote = () => {
    if (!editingAiContextNoteId) return;
    const notes = getAiContextNotes();
    const newNotes = notes.map((n: any) => n.id === editingAiContextNoteId ? { ...n, text: editingAiContextNoteText } : n);
    const newContextString = JSON.stringify(newNotes);
    onUpdate(newContextString);
    setEditingAiContextNoteId(null);
    setEditingAiContextNoteText('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI Context Notes</CardTitle>
        <CardDescription>Provide manual context to the AI (e.g., "I will be out of work next Tuesday", "We have guests this weekend").</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            {getAiContextNotes().map((note: any) => (
              <div key={note.id} className="flex items-start gap-2 p-3 bg-slate-50 border border-slate-100 rounded-lg">
                {editingAiContextNoteId === note.id ? (
                  <div className="flex-1 flex gap-2">
                    <textarea
                      className="flex-1 min-h-[60px] p-2 text-sm border border-slate-200 rounded-md focus:ring-2 focus:ring-slate-900 outline-none resize-y"
                      value={editingAiContextNoteText}
                      onChange={e => setEditingAiContextNoteText(e.target.value)}
                    />
                    <div className="flex flex-col gap-2">
                      <Button size="sm" onClick={handleSaveEditAiContextNote} className="bg-emerald-600 hover:bg-emerald-700 text-white">Save</Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingAiContextNoteId(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex-1 text-sm text-slate-700 whitespace-pre-wrap">{note.text}</div>
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-slate-600" onClick={() => handleStartEditAiContextNote(note.id, note.text)}>
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-slate-400 hover:text-red-500" onClick={() => handleDeleteAiContextNote(note.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
            {getAiContextNotes().length === 0 && (
              <div className="text-sm text-slate-500 italic p-4 text-center border border-dashed border-slate-200 rounded-lg">No context notes added yet.</div>
            )}
          </div>
          <div className="flex gap-2 items-start mt-4">
            <textarea
              className="flex-1 min-h-[80px] p-3 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-slate-900 focus:border-transparent outline-none resize-y"
              placeholder="Add any upcoming events, schedule changes, or context the AI should know about..."
              value={newAiContextNote}
              onChange={e => setNewAiContextNote(e.target.value)}
            />
            <Button onClick={handleAddAiContextNote} className="bg-slate-900 text-white hover:bg-slate-800 h-10">Add Note</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
