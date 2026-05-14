import React from 'react';
import { createRoot } from 'react-dom/client';
import { OnboardingApp } from './App';
import './styles.css';

const root = createRoot(document.getElementById('onboarding-root')!);
root.render(<React.StrictMode><OnboardingApp /></React.StrictMode>);
