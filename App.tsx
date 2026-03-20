import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { SignalsProvider } from './context/SignalsContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import SignalDetails from './pages/SignalDetails';
import Scanner from './pages/Scanner';
import Admin from './pages/Admin';
import { LoginGate } from './components/LoginGate';
import Backtest from './pages/Backtest';

const App: React.FC = () => {
  return (
    <SignalsProvider>
      <LoginGate>
        <HashRouter>
          <Layout>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/scanner" element={<Scanner />} />
              <Route path="/signal/:id" element={<SignalDetails />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/backtest" element={<Backtest />} />
            </Routes>
          </Layout>
        </HashRouter>
      </LoginGate>
    </SignalsProvider>
  );
};

export default App;