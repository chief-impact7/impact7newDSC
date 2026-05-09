import { getAI, getGenerativeModel, VertexAIBackend } from 'firebase/ai';
import { app } from './firebase-config.js';

const ai = getAI(app, { backend: new VertexAIBackend('global') });

export const geminiModel = getGenerativeModel(ai, { model: 'gemini-3-flash-preview' });
