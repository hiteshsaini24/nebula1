import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { BookOpen, Brain, Trophy, TrendingUp, LogOut, CheckCircle, Circle, Sparkles } from 'lucide-react';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

// Configure axios to send cookies
axios.defaults.withCredentials = true;

export default function SmartLearningApp() {
  const [user, setUser] = useState(null);
  const [currentView, setCurrentView] = useState('dashboard');
  const [learningPaths, setLearningPaths] = useState([]);
  const [activePath, setActivePath] = useState(null);
  const [currentLesson, setCurrentLesson] = useState(null);
  const [quiz, setQuiz] = useState(null);
  const [quizAnswers, setQuizAnswers] = useState({});
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const [newTopic, setNewTopic] = useState('');
  const [stats, setStats] = useState(null);

  // Check authentication on mount
  useEffect(() => {
    checkAuth();
  }, []);

  // Fetch learning paths when user logs in
  useEffect(() => {
    if (user) {
      fetchLearningPaths();
      fetchStats();
    }
  }, [user]);

  const checkAuth = async () => {
    try {
      const response = await axios.get(`${API_URL}/auth/user`);
      setUser(response.data);
    } catch (error) {
      // User not authenticated
      setUser(null);
    }
  };

  const handleGoogleLogin = () => {
    window.location.href = `${API_URL}/auth/google`;
  };

  const handleLogout = async () => {
    try {
      await axios.post(`${API_URL}/auth/logout`);
      setUser(null);
      setLearningPaths([]);
      setActivePath(null);
      setCurrentView('dashboard');
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const fetchLearningPaths = async () => {
    try {
      const response = await axios.get(`${API_URL}/learning-paths`);
      setLearningPaths(response.data);
    } catch (error) {
      console.error('Error fetching paths:', error);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await axios.get(`${API_URL}/stats`);
      setStats(response.data);
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  const generateLearningPath = async () => {
    if (!newTopic.trim()) return;
    
    setLoading(true);
    try {
      const response = await axios.post(`${API_URL}/learning-paths/generate`, {
        topic: newTopic
      });
      setLearningPaths([response.data, ...learningPaths]);
      setNewTopic('');
      fetchStats();
    } catch (error) {
      console.error('Error generating path:', error);
      alert('Failed to generate learning path. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const generateQuiz = async (lesson) => {
    setLoading(true);
    try {
      const response = await axios.post(`${API_URL}/quizzes/generate`, {
        pathId: activePath._id,
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        lessonContent: lesson.content
      });
      
      setQuiz(response.data);
      setQuizAnswers({});
      setShowResults(false);
      setCurrentView('quiz');
    } catch (error) {
      console.error('Error generating quiz:', error);
      alert('Failed to generate quiz. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const completeLesson = async () => {
    try {
      const response = await axios.patch(
        `${API_URL}/learning-paths/${activePath._id}/lessons/${currentLesson.id}/complete`
      );
      
      // Update local state
      const updatedPath = response.data;
      setLearningPaths(learningPaths.map(p => 
        p._id === updatedPath._id ? updatedPath : p
      ));
      setActivePath(updatedPath);
      fetchStats();
      
      if (currentLesson.hasQuiz) {
        generateQuiz(currentLesson);
      } else {
        setCurrentView('path');
      }
    } catch (error) {
      console.error('Error completing lesson:', error);
      alert('Failed to complete lesson. Please try again.');
    }
  };

  const submitQuiz = async () => {
    try {
      const response = await axios.post(`${API_URL}/quizzes/submit`, {
        pathId: activePath._id,
        lessonId: currentLesson.id,
        answers: quizAnswers,
        questions: quiz.questions
      });
      
      setShowResults(true);
      fetchStats();
    } catch (error) {
      console.error('Error submitting quiz:', error);
      alert('Failed to submit quiz. Please try again.');
    }
  };

  const calculateScore = () => {
    if (!quiz) return 0;
    const correct = quiz.questions.filter((q, idx) => 
      quizAnswers[idx] === q.correct
    ).length;
    return Math.round((correct / quiz.questions.length) * 100);
  };

  // Rest of your component remains the same...
  // (Keep all the UI rendering code from the original component)
}