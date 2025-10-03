// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

const app = express();

// ====================
// MIDDLEWARE SETUP
// ====================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ====================
// DATABASE CONNECTION
// ====================

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// ====================
// DATABASE MODELS
// ====================

const UserSchema = new mongoose.Schema({
  googleId: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  picture: String,
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now }
});

const LessonSchema = new mongoose.Schema({
  id: Number,
  title: String,
  content: String,
  completed: { type: Boolean, default: false },
  hasQuiz: { type: Boolean, default: true },
  completedAt: Date
});

const LearningPathSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  description: String,
  progress: { type: Number, default: 0 },
  lessons: [LessonSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const QuizResultSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  pathId: { type: mongoose.Schema.Types.ObjectId, ref: 'LearningPath', required: true },
  lessonId: Number,
  score: Number,
  answers: [Number],
  completedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const LearningPath = mongoose.model('LearningPath', LearningPathSchema);
const QuizResult = mongoose.model('QuizResult', QuizResultSchema);

// ====================
// SESSION SETUP
// ====================

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    touchAfter: 24 * 3600 // lazy session update
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in production
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// ====================
// PASSPORT SETUP (Google OAuth)
// ====================

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/api/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await User.findOne({ googleId: profile.id });
      
      if (!user) {
        user = await User.create({
          googleId: profile.id,
          email: profile.emails[0].value,
          name: profile.displayName,
          picture: profile.photos[0]?.value
        });
      } else {
        user.lastLogin = new Date();
        await user.save();
      }
      
      return done(null, user);
    } catch (error) {
      return done(error, null);
    }
  }
));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// ====================
// ANTHROPIC CLAUDE SETUP
// ====================

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ====================
// MIDDLEWARE - AUTH CHECK
// ====================

const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized. Please login.' });
};

// ====================
// AUTH ROUTES
// ====================

// Initiate Google OAuth
app.get('/api/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google OAuth callback
app.get('/api/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:3000');
  }
);

// Get current user
app.get('/api/auth/user', isAuthenticated, (req, res) => {
  res.json({
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    picture: req.user.picture
  });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ message: 'Logged out successfully' });
  });
});

// ====================
// LEARNING PATH ROUTES
// ====================

// Generate learning path with Claude
app.post('/api/learning-paths/generate', isAuthenticated, async (req, res) => {
  try {
    const { topic } = req.body;
    
    if (!topic || topic.trim().length === 0) {
      return res.status(400).json({ error: 'Topic is required' });
    }

    // Call Claude API to generate learning path
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Create a comprehensive learning path for "${topic}". Generate exactly 4-6 lessons with:
        1. A clear, engaging lesson title
        2. A detailed lesson content (2-3 paragraphs explaining key concepts)
        3. Each lesson should build on the previous one
        
        Format your response as JSON with this structure:
        {
          "title": "Learning Path Title",
          "description": "Brief description",
          "lessons": [
            {
              "title": "Lesson title",
              "content": "Detailed lesson content"
            }
          ]
        }`
      }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const pathData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!pathData) {
      throw new Error('Failed to parse Claude response');
    }

    // Create learning path in database
    const lessons = pathData.lessons.map((lesson, idx) => ({
      id: idx + 1,
      title: lesson.title,
      content: lesson.content,
      completed: false,
      hasQuiz: true
    }));

    const learningPath = await LearningPath.create({
      userId: req.user._id,
      title: pathData.title,
      description: pathData.description,
      progress: 0,
      lessons
    });

    res.json(learningPath);
  } catch (error) {
    console.error('Error generating learning path:', error);
    res.status(500).json({ error: 'Failed to generate learning path' });
  }
});

// Get all learning paths for user
app.get('/api/learning-paths', isAuthenticated, async (req, res) => {
  try {
    const paths = await LearningPath.find({ userId: req.user._id })
      .sort({ createdAt: -1 });
    res.json(paths);
  } catch (error) {
    console.error('Error fetching learning paths:', error);
    res.status(500).json({ error: 'Failed to fetch learning paths' });
  }
});

// Get single learning path
app.get('/api/learning-paths/:id', isAuthenticated, async (req, res) => {
  try {
    const path = await LearningPath.findOne({
      _id: req.params.id,
      userId: req.user._id
    });
    
    if (!path) {
      return res.status(404).json({ error: 'Learning path not found' });
    }
    
    res.json(path);
  } catch (error) {
    console.error('Error fetching learning path:', error);
    res.status(500).json({ error: 'Failed to fetch learning path' });
  }
});

// Update lesson completion
app.patch('/api/learning-paths/:id/lessons/:lessonId/complete', isAuthenticated, async (req, res) => {
  try {
    const path = await LearningPath.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!path) {
      return res.status(404).json({ error: 'Learning path not found' });
    }

    const lesson = path.lessons.find(l => l.id === parseInt(req.params.lessonId));
    if (!lesson) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    lesson.completed = true;
    lesson.completedAt = new Date();

    // Update progress
    const completedCount = path.lessons.filter(l => l.completed).length;
    path.progress = (completedCount / path.lessons.length) * 100;
    path.updatedAt = new Date();

    await path.save();
    res.json(path);
  } catch (error) {
    console.error('Error updating lesson:', error);
    res.status(500).json({ error: 'Failed to update lesson' });
  }
});

// ====================
// QUIZ ROUTES
// ====================

// Generate quiz with Claude
app.post('/api/quizzes/generate', isAuthenticated, async (req, res) => {
  try {
    const { pathId, lessonId, lessonTitle, lessonContent } = req.body;

    if (!pathId || !lessonId || !lessonTitle || !lessonContent) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Call Claude API to generate quiz
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Based on this lesson:
        Title: ${lessonTitle}
        Content: ${lessonContent}
        
        Generate exactly 5 multiple-choice questions that test understanding of the key concepts.
        
        Format your response as JSON:
        {
          "questions": [
            {
              "question": "Question text",
              "options": ["Option A", "Option B", "Option C", "Option D"],
              "correct": 0
            }
          ]
        }
        
        The "correct" field should be the index (0-3) of the correct answer.`
      }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const quizData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!quizData || !quizData.questions) {
      throw new Error('Failed to parse Claude response');
    }

    // Add IDs to questions
    const questions = quizData.questions.map((q, idx) => ({
      id: idx + 1,
      ...q
    }));

    res.json({
      pathId,
      lessonId,
      questions
    });
  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: 'Failed to generate quiz' });
  }
});

// Submit quiz results
app.post('/api/quizzes/submit', isAuthenticated, async (req, res) => {
  try {
    const { pathId, lessonId, answers, questions } = req.body;

    if (!pathId || !lessonId || !answers || !questions) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Calculate score
    let correctCount = 0;
    questions.forEach((q, idx) => {
      if (answers[idx] === q.correct) {
        correctCount++;
      }
    });

    const score = Math.round((correctCount / questions.length) * 100);

    // Save quiz result
    const result = await QuizResult.create({
      userId: req.user._id,
      pathId,
      lessonId,
      score,
      answers: Object.values(answers)
    });

    res.json({
      score,
      correctCount,
      totalQuestions: questions.length,
      resultId: result._id
    });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    res.status(500).json({ error: 'Failed to submit quiz' });
  }
});

// Get quiz history
app.get('/api/quizzes/history', isAuthenticated, async (req, res) => {
  try {
    const results = await QuizResult.find({ userId: req.user._id })
      .sort({ completedAt: -1 })
      .limit(20);
    res.json(results);
  } catch (error) {
    console.error('Error fetching quiz history:', error);
    res.status(500).json({ error: 'Failed to fetch quiz history' });
  }
});

// ====================
// STATS ROUTE
// ====================

app.get('/api/stats', isAuthenticated, async (req, res) => {
  try {
    const paths = await LearningPath.find({ userId: req.user._id });
    const quizResults = await QuizResult.find({ userId: req.user._id });

    const totalPaths = paths.length;
    const completedLessons = paths.reduce((acc, path) => 
      acc + path.lessons.filter(l => l.completed).length, 0
    );
    const totalLessons = paths.reduce((acc, path) => acc + path.lessons.length, 0);
    const overallProgress = totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0;
    const averageQuizScore = quizResults.length > 0
      ? quizResults.reduce((acc, r) => acc + r.score, 0) / quizResults.length
      : 0;

    res.json({
      totalPaths,
      completedLessons,
      totalLessons,
      overallProgress: Math.round(overallProgress),
      averageQuizScore: Math.round(averageQuizScore),
      totalQuizzes: quizResults.length
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ====================
// HEALTH CHECK
// ====================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ====================
// ERROR HANDLING
// ====================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});

// ====================
// START SERVER
// ====================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
});
