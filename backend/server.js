require('dotenv').config();
const express = require('express');
const { supabaseAdmin } = require('./lib/supabase');
const bcrypt = require('bcrypt');
const cors = require('cors');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { createClient } = require('redis');
const Brevo = require('@getbrevo/brevo');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const QR_TOKEN_SECRET = process.env.QR_TOKEN_SECRET;
const QR_TOKEN_VALIDITY_MS = 18000;

if (!QR_TOKEN_SECRET) {
    throw new Error('QR_TOKEN_SECRET environment variable is required');
}

const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

const apiInstance = new Brevo.TransactionalEmailsApi();
const apiKey = apiInstance.authentications['apiKey'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const app = express();

app.use(helmet());

// FIX: Only call express.json() ONCE (was called twice in new server)
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000, // increased from 500 — college app with many concurrent users
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        console.warn(`⚠️ Rate limit exceeded for ${req.ip} on ${req.method} ${req.url}`);
        res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    }
});
app.use(limiter);

const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// --- Redis Client (caching only) ---
let redisClient = {
    isOpen: false,
    get: async () => null,
    set: async () => null,
    del: async () => null,
    connect: async () => { }
};

(async () => {
    try {
        const realClient = createClient({
            url: process.env.REDIS_URL,
            socket: {
                connectTimeout: 5000,
                reconnectStrategy: (retries) => {
                    if (retries > 2) return false;
                    return 1000;
                }
            }
        });
        realClient.on('error', () => { });
        realClient.on('connect', () => console.log('✅ Connected to Redis Cloud (cache only)'));
        await realClient.connect();
        redisClient = realClient;
    } catch (err) {
        console.log('⚠️ Redis unavailable — running without cache (non-fatal)');
    }
})();

if (IS_PRODUCTION) {
    app.set('trust proxy', 1);
}

const allowedOrigins = [
    process.env.FRONTEND_URL,
    'https://www.flobms.com',
    'https://flobms.com'
].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('❌ CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.options('*', cors());

app.get('/', (req, res) => {
    res.send('🚀 Flobms backend server is running successfully');
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

app.use((req, res, next) => {
    console.log(`\n📝 ${req.method} ${req.url}`);
    next();
});

async function testSupabaseConnection() {
    try {
        const { data, error } = await supabaseAdmin.from('student').select('count').limit(1);
        if (error) throw error;
        console.log('✅ Supabase connected successfully');
    } catch (err) {
        console.error('❌ Supabase connection failed:', err);
    }
}
testSupabaseConnection();

// --- Auth Middleware: requires full student profile ---
async function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.log('❌ User NOT authenticated - no token');
        return res.status(401).json({ error: 'Please sign in first' });
    }
    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) {
            console.log('❌ Invalid/expired token:', error?.message || 'no user returned');
            return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }
        const { data: student, error: studentError } = await supabaseAdmin
            .from('student')
            .select('usn, sname, emailid')
            .eq('auth_id', user.id)
            .maybeSingle();
        if (studentError || !student) {
            console.log('❌ No student record found for auth user:', user.id);
            return res.status(401).json({ error: 'Account not fully set up. Please complete your profile.', needsOnboarding: true });
        }
        req.session = {
            userUSN: student.usn,
            userName: student.sname,
            userEmail: student.emailid,
            accessToken: token,
            authId: user.id
        };
        next();
    } catch (err) {
        console.error('❌ Auth error:', err.message);
        return res.status(401).json({ error: 'Authentication error' });
    }
}

// --- Auth Middleware: only validates Supabase token, no student record needed (for Google onboarding) ---
async function requireAuthToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Please sign in first' });
    }
    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }
        req.session = {
            authId: user.id,
            userEmail: user.email,
            accessToken: token
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Authentication error' });
    }
}

const uploadFromBuffer = (buffer) => {
    return new Promise((resolve, reject) => {
        const cld_upload_stream = cloudinary.uploader.upload_stream(
            { folder: "event_banners" },
            (error, result) => {
                if (result) resolve(result);
                else reject(error);
            }
        );
        streamifier.createReadStream(buffer).pipe(cld_upload_stream);
    });
};

// ==================== AUTH ENDPOINTS ====================

app.post('/api/signup', async (req, res) => {
    try {
        const { name, usn, sem, mobno, email, password, organizerPin } = req.body;
        if (!usn || !name || !email || !sem || !mobno || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (organizerPin && !/^\d{4,6}$/.test(organizerPin)) {
            return res.status(400).json({ error: 'Organizer PIN must be 4 to 6 digits' });
        }
        const { data: existing } = await supabaseAdmin
            .from('student').select('usn').or(`usn.eq.${usn},emailid.eq.${email}`).limit(1);
        if (existing && existing.length > 0) {
            return res.status(400).json({ error: 'Student with this USN or email already exists' });
        }
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email, password, email_confirm: true, user_metadata: { usn, name }
        });
        if (authError) {
            console.error('Error creating auth user:', authError);
            return res.status(400).json({ error: authError.message });
        }
        let hashedPin = null;
        if (organizerPin) hashedPin = await bcrypt.hash(organizerPin, 10);
        const { error: studentError } = await supabaseAdmin.from('student').insert([{
            usn, sname: name, sem, mobno, emailid: email,
            auth_id: authData.user.id, organizer_pin: hashedPin
        }]);
        if (studentError) {
            await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
            console.error('Error inserting student:', studentError);
            return res.status(500).json({ error: 'Error registering student' });
        }
        const { data: signInData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({ email, password });
        if (signInError) {
            return res.status(500).json({ error: 'Registered but could not sign in automatically' });
        }
        console.log('✅ Student registered:', usn);
        res.status(201).json({
            success: true, message: 'Student registered successfully!',
            token: signInData.session.access_token,
            refresh_token: signInData.session.refresh_token,
            userUSN: usn, userName: name
        });
    } catch (err) {
        console.error('Error registering student:', err);
        res.status(500).json({ error: `Error registering student: ${err.message}` });
    }
});

app.post('/api/signin', async (req, res) => {
    try {
        const { usn, password } = req.body;
        if (!usn || !password) {
            return res.status(400).json({ error: 'USN and password are required' });
        }
        const { data: student, error: lookupError } = await supabaseAdmin
            .from('student').select('usn, sname, emailid').eq('usn', usn).maybeSingle();
        if (lookupError || !student) {
            return res.status(401).json({ error: 'Invalid USN or password' });
        }
        const { data, error } = await supabaseAdmin.auth.signInWithPassword({
            email: student.emailid, password
        });
        if (error) {
            return res.status(401).json({ error: 'Invalid USN or password' });
        }
        console.log('✅ User signed in:', student.usn);
        res.json({
            success: true, message: 'Signed in successfully',
            token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            userUSN: student.usn, userName: student.sname
        });
    } catch (err) {
        console.error('Error signing in:', err);
        res.status(500).json({ error: `Error signing in: ${err.message}` });
    }
});

// FIX: signout is graceful — works even if token is missing/expired
app.post('/api/signout', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token) {
            try {
                await supabaseAdmin.auth.admin.signOut(token);
            } catch (e) {
                // non-fatal — token may already be expired
            }
        }
        console.log('✅ User signed out');
        res.json({ success: true, message: 'Signed out successfully' });
    } catch (err) {
        res.json({ success: true, message: 'Signed out successfully' });
    }
});

app.get('/api/me', requireAuth, async (req, res) => {
    try {
        const { data: rows, error } = await supabaseAdmin
            .from('student')
            .select('usn, sname, sem, mobno, emailid, organizer_pin, auth_id')
            .eq('usn', req.session.userUSN)
            .limit(1);
        if (error || !rows?.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        const student = rows[0];
        let hasGoogleIdentity = false;
        let hasPasswordIdentity = false;
        try {
            const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(student.auth_id);
            hasGoogleIdentity = user?.identities?.some(i => i.provider === 'google') || false;
            hasPasswordIdentity = user?.identities?.some(i => i.provider === 'email') || false;
        } catch (e) {
            // non-fatal
        }
        res.json({
            userUSN: student.usn, userName: student.sname, semester: student.sem,
            mobile: student.mobno, email: student.emailid,
            hasPinSet: !!student.organizer_pin, hasGoogleIdentity, hasPasswordIdentity
        });
    } catch (err) {
        console.error('Error fetching user info:', err);
        res.status(500).json({ error: 'Error fetching user info' });
    }
});

app.put('/api/profile', requireAuth, async (req, res) => {
    try {
        const { sname, sem, mobno } = req.body;
        if (!sname || !sem || !mobno) {
            return res.status(400).json({ error: 'All fields are required' });
        }
        if (!/^\d{10}$/.test(mobno)) {
            return res.status(400).json({ error: 'Mobile must be 10 digits' });
        }
        const semNum = parseInt(sem, 10);
        if (semNum < 1 || semNum > 8) {
            return res.status(400).json({ error: 'Semester must be 1-8' });
        }
        const { error } = await supabaseAdmin
            .from('student').update({ sname, sem: semNum, mobno }).eq('usn', req.session.userUSN);
        if (error) return res.status(500).json({ error: 'Failed to update profile' });
        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Both fields are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }
        const { error: authError } = await supabaseAdmin.auth.signInWithPassword({
            email: req.session.userEmail, password: currentPassword
        });
        if (authError) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }
        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
            req.session.authId, { password: newPassword }
        );
        if (updateError) {
            return res.status(500).json({ error: 'Failed to update password' });
        }
        const { data: newSession, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
            email: req.session.userEmail, password: newPassword
        });
        if (signInError || !newSession?.session) {
            return res.status(500).json({ error: 'Password changed but could not refresh session. Please sign in again.' });
        }
        res.json({
            success: true, message: 'Password changed successfully',
            token: newSession?.session?.access_token || null,
            refresh_token: newSession?.session?.refresh_token || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== PASSWORD RESET (using Supabase Auth) ====================

app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        // Always return success to prevent email enumeration
        const { data: user } = await supabaseAdmin
            .from('student').select('usn, sname').eq('emailid', email).maybeSingle();

        if (user) {
            // Use Supabase built-in password reset
            const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
                redirectTo: `${process.env.FRONTEND_URL}/reset-password`
            });
            if (error) {
                console.error('Error sending reset email:', error);
            } else {
                console.log('✅ Password reset email sent to:', email);
            }
        }

        res.json({ success: true, message: 'If an account exists, you will receive a reset link.' });
    } catch (err) {
        console.error('Error in forgot password:', err);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

// FIX: Supabase Auth handles token verification — this endpoint accepts the new password
// after the user clicks the reset link (frontend should exchange the token via Supabase client)
app.post('/api/reset-password', async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Token and new password are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters long' });
        }
        // Verify the recovery token using Supabase
        const { data, error } = await supabaseAdmin.auth.verifyOtp({
            token_hash: token,
            type: 'recovery'
        });
        if (error || !data?.user) {
            return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
        }
        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
            data.user.id, { password: newPassword }
        );
        if (updateError) {
            return res.status(500).json({ error: 'Failed to reset password' });
        }
        const { data: student } = await supabaseAdmin
            .from('student').select('sname').eq('auth_id', data.user.id).maybeSingle();
        console.log('✅ Password reset successful for auth user:', data.user.id);
        res.json({
            success: true,
            message: 'Password reset successfully! You can now sign in with your new password.',
            userName: student?.sname || ''
        });
    } catch (err) {
        console.error('Error in reset password:', err);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

// ==================== GOOGLE AUTH ONBOARDING ====================

// FIX: Added GET handler — frontend was calling GET /api/complete-google-signup
// This returns the current onboarding status for a Google-authed user
app.get('/api/complete-google-signup', requireAuthToken, async (req, res) => {
    try {
        const { data: student } = await supabaseAdmin
            .from('student').select('usn, sname').eq('auth_id', req.session.authId).maybeSingle();
        if (student) {
            return res.json({ needsOnboarding: false, userUSN: student.usn, userName: student.sname });
        }
        const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(req.session.authId);
        res.json({
            needsOnboarding: true,
            email: user?.email || '',
            name: user?.user_metadata?.full_name || user?.email?.split('@')[0] || ''
        });
    } catch (err) {
        console.error('Error checking onboarding status:', err);
        res.status(500).json({ error: 'Failed to check onboarding status' });
    }
});

app.post('/api/complete-google-signup', requireAuthToken, async (req, res) => {
    try {
        const { usn, sem, mobno, organizerPin } = req.body;
        if (!usn || !sem || !mobno) {
            return res.status(400).json({ error: 'USN, semester and mobile are required' });
        }
        if (organizerPin && !/^\d{4,6}$/.test(organizerPin)) {
            return res.status(400).json({ error: 'Organizer PIN must be 4 to 6 digits' });
        }
        const { data: existing } = await supabaseAdmin
            .from('student').select('usn').eq('usn', usn).maybeSingle();
        if (existing) return res.status(400).json({ error: 'This USN is already registered' });
        const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(req.session.authId);
        const name = user.user_metadata?.full_name || user.email.split('@')[0];
        const email = user.email;
        const hashedPin = organizerPin ? await bcrypt.hash(organizerPin, 10) : null;
        const { error: insertError } = await supabaseAdmin.from('student').insert([{
            usn, sname: name, sem: parseInt(sem), mobno, emailid: email,
            auth_id: req.session.authId, organizer_pin: hashedPin
        }]);
        if (insertError) {
            console.error('Error creating student record:', insertError);
            return res.status(500).json({ error: 'Failed to complete profile setup' });
        }
        console.log('✅ Google user onboarded:', usn);
        res.json({ success: true, userName: name, userUSN: usn });
    } catch (err) {
        console.error('Error in Google onboarding:', err);
        res.status(500).json({ error: 'Failed to complete setup' });
    }
});

// ==================== EVENTS ====================

// FIX: Fetch full event list with all fields including banner_url
app.get('/api/events', requireAuth, async (req, res) => {
    try {
        const currentDate = new Date().toISOString().split('T')[0];
        const cacheKey = 'events_list_raw';
        let rows = null;
        try {
            if (redisClient.isOpen) {
                const cachedData = await redisClient.get(cacheKey);
                if (cachedData) rows = JSON.parse(cachedData);
            }
        } catch (cacheErr) { console.error('Redis read error:', cacheErr.message); }
        if (!rows) {
            const { data, error } = await supabaseAdmin
                .from('event')
                .select(`
                    eid, ename, eventdesc, eventdate, eventtime, eventloc, maxpart, maxvoln, regfee,
                    upi_id, is_team, min_team_size, max_team_size, poster_url, banner_url,
                    activity_points, max_activity_pts, vol_activity_pts, min_part_scans, min_voln_scans,
                    certificate_info,
                    club:orgcid(cname), student:orgusn(sname)
                `);
            if (error) throw error;
            rows = data;
            try {
                if (redisClient.isOpen) await redisClient.set(cacheKey, JSON.stringify(rows), { EX: 600 });
            } catch (saveErr) { console.error('Redis write error:', saveErr.message); }
        }
        const events = { ongoing: [], completed: [], upcoming: [] };
        (rows || []).forEach(event => {
            const transformedEvent = {
                ...event,
                eventDate: event.eventdate, eventTime: event.eventtime, eventLoc: event.eventloc,
                maxPart: event.maxpart, maxVoln: event.maxvoln, regFee: event.regfee,
                upiId: event.upi_id, posterUrl: event.poster_url, bannerUrl: event.banner_url,
                is_team: event.is_team, min_team_size: event.min_team_size, max_team_size: event.max_team_size,
                activityPoints: event.activity_points || 0, maxActivityPts: event.max_activity_pts || 0,
                volActivityPts: event.vol_activity_pts || 0,
                certificateInfo: event.certificate_info,
                clubName: event.club?.cname, organizerName: event.student?.sname
            };
            const eventDate = new Date(event.eventdate).toISOString().split('T')[0];
            if (eventDate === currentDate) events.ongoing.push(transformedEvent);
            else if (eventDate < currentDate) events.completed.push(transformedEvent);
            else events.upcoming.push(transformedEvent);
        });
        res.json({ events, currentUser: req.session.userUSN });
    } catch (err) {
        console.error('Error fetching events:', err);
        res.status(500).json({ error: 'Error fetching events' });
    }
});

// FIX: Single event fetch now includes ALL fields: banner_url, upi_id, is_team, certificate_info, etc.
app.get('/api/events/:eventId', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        if (!eventId || isNaN(eventId)) return res.status(400).json({ error: 'Invalid event ID' });
        const { data: rows, error } = await supabaseAdmin
            .from('event')
            .select(`
                eid, ename, eventdesc, eventdate, eventtime, eventloc, maxpart, maxvoln, regfee,
                orgusn, upi_id, is_team, min_team_size, max_team_size,
                poster_url, banner_url, activity_points, certificate_info,
                max_activity_pts, vol_activity_pts, min_part_scans, min_voln_scans,
                club:orgcid(cname), student:orgusn(sname)
            `)
            .eq('eid', eventId).limit(1);
        if (error) return res.status(500).json({ error: 'Database error' });
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'Event not found' });
        const event = rows[0];
        const transformedEvent = {
            ...event,
            eventDate: event.eventdate, eventTime: event.eventtime, eventLoc: event.eventloc,
            maxPart: event.maxpart, maxVoln: event.maxvoln, regFee: event.regfee,
            upiId: event.upi_id, posterUrl: event.poster_url, bannerUrl: event.banner_url,
            activityPoints: event.activity_points || 0,
            maxActivityPts: event.max_activity_pts || 0, volActivityPts: event.vol_activity_pts || 0,
            minPartScans: event.min_part_scans || 1, minVolnScans: event.min_voln_scans || 1,
            certificateInfo: event.certificate_info,
            clubName: event.club?.cname, organizerName: event.student?.sname, OrgUsn: event.orgusn
        };
        const { data: participantCheck } = await supabaseAdmin
            .from('participant').select('partstatus, payment_status')
            .eq('partusn', req.session.userUSN).eq('parteid', eventId).limit(1);
        const { data: volunteerCheck } = await supabaseAdmin
            .from('volunteer').select('volnstatus')
            .eq('volnusn', req.session.userUSN).eq('volneid', eventId).limit(1);
        transformedEvent.isRegistered = participantCheck && participantCheck.length > 0;
        transformedEvent.paymentStatus = participantCheck?.[0]?.payment_status || null;
        transformedEvent.isVolunteer = volunteerCheck && volunteerCheck.length > 0;
        transformedEvent.isOrganizer = event.orgusn === req.session.userUSN;
        res.json(transformedEvent);
    } catch (err) {
        res.status(500).json({ error: 'Error fetching event details: ' + err.message });
    }
});

app.post('/api/events/create', requireAuth, upload.single('banner'), async (req, res) => {
    try {
        const {
            eventName, eventDescription, certificate_info, posterUrl,
            eventDate, eventTime, eventLocation, maxParticipants, maxVolunteers,
            registrationFee, clubId, OrgCid, upiId, isTeamEvent,
            minTeamSize, maxTeamSize, activityPoints, maxActivityPts,
            volActivityPts, minPartScans, minVolnScans
        } = req.body;
        const file = req.file;
        let finalBannerUrl = null;
        if (file) {
            try {
                console.log('📤 Streaming banner to Cloudinary...');
                const result = await uploadFromBuffer(file.buffer);
                finalBannerUrl = result.secure_url;
                console.log('✅ Banner upload success:', finalBannerUrl);
            } catch (uploadErr) {
                console.error('Cloudinary Upload Error:', uploadErr);
                return res.status(500).json({ error: 'Failed to upload banner image' });
            }
        }
        const organizedClubId = (clubId || OrgCid) ? parseInt(clubId || OrgCid) : null;
        const fee = parseFloat(registrationFee) || 0;
        const isTeam = isTeamEvent === 'true' || isTeamEvent === true;
        const points = parseInt(activityPoints) || 0;
        if (organizedClubId) {
            const { data: membershipCheck, error: memberError } = await supabaseAdmin
                .from('memberof').select('clubid')
                .eq('studentusn', req.session.userUSN).eq('clubid', organizedClubId).limit(1);
            if (memberError) {
                return res.status(500).json({ error: 'Database verification failed' });
            }
            if (!membershipCheck || membershipCheck.length === 0) {
                return res.status(403).json({ error: 'Unauthorized: You are not a member of this club and cannot organize events for it.' });
            }
        }
        if (!eventName || !eventDescription || !eventDate || !eventTime || !eventLocation) {
            return res.status(400).json({ error: 'Required fields missing' });
        }
        if (fee > 0 && (!upiId || upiId.trim() === '')) {
            return res.status(400).json({ error: 'UPI ID is required for paid events' });
        }
        const eventData = {
            ename: eventName, eventdesc: eventDescription, certificate_info: certificate_info || null,
            poster_url: posterUrl || null, banner_url: finalBannerUrl,
            eventdate: eventDate, eventtime: eventTime, eventloc: eventLocation,
            maxpart: maxParticipants ? parseInt(maxParticipants) : null,
            maxvoln: maxVolunteers ? parseInt(maxVolunteers) : null,
            regfee: fee, upi_id: fee > 0 ? upiId : null,
            orgusn: req.session.userUSN, orgcid: organizedClubId || null,
            is_team: isTeam,
            min_team_size: isTeam ? (parseInt(minTeamSize) || null) : null,
            max_team_size: isTeam ? (parseInt(maxTeamSize) || null) : null,
            activity_points: points,
            max_activity_pts: parseInt(maxActivityPts) || 0,
            vol_activity_pts: parseInt(volActivityPts) || 0,
            min_part_scans: parseInt(minPartScans) || 1,
            min_voln_scans: parseInt(minVolnScans) || 1
        };
        const { data, error } = await supabaseAdmin.from('event').insert([eventData]).select('eid');
        if (error) throw error;
        const newEventId = data[0]?.eid;
        const { error: subEventError } = await supabaseAdmin.from('sub_event').insert([{
            eid: newEventId, se_name: eventName, se_details: '', activity_pts: parseInt(maxActivityPts) || 0
        }]);
        if (subEventError) console.error('Error creating default sub-event:', subEventError);
        try {
            if (redisClient.isOpen) await redisClient.del('events_list_raw');
        } catch (e) { }
        res.status(201).json({ success: true, message: 'Event created successfully!', eventId: newEventId });
    } catch (err) {
        console.error('Error creating event:', err);
        res.status(500).json({ error: `Error creating event: ${err.message}` });
    }
});

// ==================== MY EVENTS ====================

app.get('/api/my-participant-events', requireAuth, async (req, res) => {
    try {
        const { data: participantEvents, error } = await supabaseAdmin
            .from('participant')
            .select(`
                partstatus, partusn, parteid,
                event:parteid (
                    eid, ename, eventdesc, certificate_info, eventdate, eventtime, eventloc,
                    maxpart, maxvoln, regfee, poster_url, banner_url, activity_points, max_activity_pts,
                    club:orgcid(cname)
                )
            `)
            .eq('partusn', req.session.userUSN);
        if (error) {
            console.error('Error fetching participant events:', error);
            return res.status(500).json({ error: 'Database error' });
        }
        const userUSN = req.session.userUSN;
        const transformedEvents = [];
        for (const p of (participantEvents || [])) {
            const event = p.event;
            if (!event?.eid) continue;
            let earnedActivityPts = 0;
            const maxActivityPts = event.max_activity_pts || 0;
            if (maxActivityPts > 0 && p.partstatus) {
                const { data: attendanceData } = await supabaseAdmin
                    .from('sub_event_attendance')
                    .select('seid')
                    .eq('eid', event.eid).eq('usn', userUSN).eq('role', 'participant');
                if (attendanceData && attendanceData.length > 0) {
                    const seids = attendanceData.map(a => a.seid);
                    const { data: subPts } = await supabaseAdmin
                        .from('sub_event').select('seid, activity_pts').in('seid', seids);
                    const sum = (subPts || []).reduce((s, se) => s + (se.activity_pts || 0), 0);
                    earnedActivityPts = Math.min(sum, maxActivityPts);
                }
            }
            transformedEvents.push({
                ...event,
                eventDate: event.eventdate, eventTime: event.eventtime, eventLoc: event.eventloc,
                maxPart: event.maxpart, maxVoln: event.maxvoln, regFee: event.regfee,
                posterUrl: event.poster_url, bannerUrl: event.banner_url,
                activityPoints: event.activity_points || 0,
                maxActivityPts, earnedActivityPts, clubName: event.club?.cname,
                PartStatus: p.partstatus == true, PartUSN: p.partusn, role: 'participant'
            });
        }
        res.json({ participantEvents: transformedEvents, userUSN: req.session.userUSN });
    } catch (err) {
        console.error('Error fetching participant events:', err);
        res.status(500).json({ error: 'Error fetching participant events' });
    }
});

app.get('/api/my-volunteer-events', requireAuth, async (req, res) => {
    try {
        const { data: volunteerEvents, error } = await supabaseAdmin
            .from('volunteer')
            .select(`
                volnstatus, volnusn, volneid,
                event:volneid (
                    eid, ename, eventdesc, eventdate, eventtime, eventloc, maxpart, maxvoln, regfee,
                    poster_url, banner_url, vol_activity_pts, club:orgcid(cname)
                )
            `)
            .eq('volnusn', req.session.userUSN);
        if (error) {
            console.error('Error fetching volunteer events:', error);
            return res.status(500).json({ error: 'Database error' });
        }
        const transformedEvents = (volunteerEvents || []).map(v => {
            const volActivityPts = v.event?.vol_activity_pts || 0;
            return {
                ...v.event,
                eventDate: v.event?.eventdate, eventTime: v.event?.eventtime, eventLoc: v.event?.eventloc,
                maxPart: v.event?.maxpart, maxVoln: v.event?.maxvoln, regFee: v.event?.regfee,
                posterUrl: v.event?.poster_url, bannerUrl: v.event?.banner_url,
                volActivityPts, earnedActivityPts: v.volnstatus ? volActivityPts : 0,
                clubName: v.event?.club?.cname, VolnStatus: v.volnstatus == true, role: 'volunteer'
            };
        }).filter(e => e.eid);
        res.json({ volunteerEvents: transformedEvents, userUSN: req.session.userUSN });
    } catch (err) {
        console.error('Error fetching volunteer events:', err);
        res.status(500).json({ error: 'Error fetching volunteer events' });
    }
});

app.get('/api/my-organized-events', requireAuth, async (req, res) => {
    try {
        const { data: organizerEvents, error } = await supabaseAdmin
            .from('event')
            .select(`
                eid, ename, eventdesc, eventdate, eventtime, eventloc, maxpart, maxvoln, regfee,
                upi_id, poster_url, banner_url, activity_points, club:orgcid(cname)
            `)
            .eq('orgusn', req.session.userUSN);
        if (error) {
            console.error('Error fetching organized events:', error);
            return res.status(500).json({ error: 'Database error' });
        }
        const transformedEvents = (organizerEvents || []).map(e => ({
            ...e,
            eventDate: e.eventdate, eventTime: e.eventtime, eventLoc: e.eventloc,
            maxPart: e.maxpart, maxVoln: e.maxvoln, regFee: e.regfee,
            upiId: e.upi_id, posterUrl: e.poster_url, bannerUrl: e.banner_url,
            activityPoints: e.activity_points || 0, clubName: e.club?.cname, role: 'organizer'
        }));
        res.json({ organizerEvents: transformedEvents, userUSN: req.session.userUSN });
    } catch (err) {
        console.error('Error fetching organized events:', err);
        res.status(500).json({ error: 'Error fetching organized events' });
    }
});

// ==================== JOIN / VOLUNTEER ====================

// Join as participant (free events)
// RULES: organizer cannot join own event | volunteer cannot join as participant
app.post('/api/events/:eventId/join', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { data: existing } = await supabaseAdmin
            .from('participant').select('*').eq('partusn', userUSN).eq('parteid', eventId).limit(1);
        if (existing && existing.length > 0) {
            return res.status(400).json({ error: 'Already joined this event' });
        }
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('maxpart, regfee, orgusn').eq('eid', eventId).limit(1);
        if (eventError) return res.status(500).json({ error: 'Database error' });
        if (!event || event.length === 0) return res.status(404).json({ error: 'Event not found' });
        if (event[0].orgusn === userUSN) {
            return res.status(403).json({ error: 'You cannot register as a participant in an event you are organizing' });
        }
        const { data: volCheck } = await supabaseAdmin
            .from('volunteer').select('volnusn').eq('volnusn', userUSN).eq('volneid', eventId).limit(1);
        if (volCheck && volCheck.length > 0) {
            return res.status(403).json({ error: 'You are already volunteering for this event. Volunteers cannot also register as participants.' });
        }
        const regFee = event[0].regfee || 0;
        if (regFee > 0) {
            return res.status(400).json({ error: 'This is a paid event. Please use the UPI payment flow.', requiresPayment: true });
        }
        const maxPart = event[0].maxpart || 0;
        if (maxPart > 0) {
            const { count } = await supabaseAdmin
                .from('participant').select('*', { count: 'exact', head: true }).eq('parteid', eventId);
            if (count >= maxPart) {
                return res.status(400).json({ error: 'No more participant slots available' });
            }
        }
        const { error: insertError } = await supabaseAdmin.from('participant').insert([{
            partusn: userUSN, parteid: eventId, partstatus: false, payment_status: 'free'
        }]);
        if (insertError) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, message: 'Successfully joined event!', userUSN });
    } catch (err) {
        console.error('Error joining event:', err);
        res.status(500).json({ error: 'Error joining event' });
    }
});

// Volunteer for event
// RULES: organizer CAN volunteer | participant cannot also volunteer
app.post('/api/events/:eventId/volunteer', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { data: existing } = await supabaseAdmin
            .from('volunteer').select('*').eq('volnusn', userUSN).eq('volneid', eventId).limit(1);
        if (existing && existing.length > 0) {
            return res.status(400).json({ error: 'Already volunteered for this event' });
        }
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('maxvoln').eq('eid', eventId).limit(1);
        if (eventError) return res.status(500).json({ error: 'Database error' });
        if (!event || event.length === 0) return res.status(404).json({ error: 'Event not found' });
        const { data: partCheck } = await supabaseAdmin
            .from('participant').select('partusn').eq('partusn', userUSN).eq('parteid', eventId).limit(1);
        if (partCheck && partCheck.length > 0) {
            return res.status(403).json({ error: 'You are already registered as a participant for this event. Participants cannot also volunteer.' });
        }
        const maxVoln = event[0].maxvoln || 0;
        if (maxVoln > 0) {
            const { count } = await supabaseAdmin
                .from('volunteer').select('*', { count: 'exact', head: true }).eq('volneid', eventId);
            if (count >= maxVoln) {
                return res.status(400).json({ error: 'No more volunteer slots available' });
            }
        }
        const { error: insertError } = await supabaseAdmin.from('volunteer').insert([{
            volnusn: userUSN, volneid: eventId, volnstatus: false
        }]);
        if (insertError) return res.status(500).json({ error: 'Database error' });
        res.json({ success: true, message: 'Successfully volunteered for event!' });
    } catch (err) {
        console.error('Error volunteering for event:', err);
        res.status(500).json({ error: 'Error volunteering for event' });
    }
});

// ==================== EVENT INFO ENDPOINTS ====================

app.get('/api/events/:eventId/volunteer-count', requireAuth, async (req, res) => {
    try {
        const { count, error } = await supabaseAdmin
            .from('volunteer').select('*', { count: 'exact', head: true }).eq('volneid', req.params.eventId);
        if (error) return res.status(500).json({ error: 'Database error' });
        res.json({ count: count || 0 });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching volunteer count' });
    }
});

app.get('/api/events/:eventId/participant-count', requireAuth, async (req, res) => {
    try {
        const { count, error } = await supabaseAdmin
            .from('participant').select('*', { count: 'exact', head: true }).eq('parteid', req.params.eventId);
        if (error) return res.status(500).json({ error: 'Database error' });
        res.json({ count: count || 0 });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching participant count' });
    }
});

app.get('/api/events/:eventId/participant-status', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event')
            .select('eid, ename, eventdesc, eventdate, eventtime, eventloc, maxpart, regfee, club:orgcid(cname)')
            .eq('eid', eventId).limit(1).maybeSingle();
        if (eventError) return res.status(500).json({ error: 'Database error' });
        if (!event) return res.status(404).json({ error: 'Event not found' });
        const { data: participant, error: partError } = await supabaseAdmin
            .from('participant').select('partstatus, payment_status')
            .eq('parteid', eventId).eq('partusn', userUSN).maybeSingle();
        if (partError) return res.status(500).json({ error: 'Database error' });
        if (!participant) return res.json({ isRegistered: false, ename: event.ename });
        res.json({
            isRegistered: true, ename: event.ename, clubName: event.club?.cname,
            eventDate: event.eventdate, eventTime: event.eventtime, eventLoc: event.eventloc,
            eventdesc: event.eventdesc, regFee: event.regfee, maxPart: event.maxpart,
            paymentStatus: participant.payment_status || (event.regfee > 0 ? 'pending' : 'verified')
        });
    } catch (err) {
        console.error('Error in participant-status route:', err);
        res.status(500).json({ error: 'Server Error' });
    }
});

// ==================== SUB-EVENTS ====================

app.get('/api/events/:eventId/sub-events', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const { data: subEvents, error } = await supabaseAdmin
            .from('sub_event').select('*').eq('eid', eventId).order('seid', { ascending: true });
        if (error) return res.status(500).json({ error: 'Database error' });
        const subEventsWithCount = await Promise.all((subEvents || []).map(async (se) => {
            const { count } = await supabaseAdmin
                .from('sub_event_attendance').select('*', { count: 'exact', head: true }).eq('seid', se.seid);
            return { ...se, attendanceCount: count || 0 };
        }));
        res.json({ subEvents: subEventsWithCount });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching sub-events' });
    }
});

app.post('/api/events/:eventId/sub-events', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const { se_name, activity_pts, se_details } = req.body;
        if (!se_name) return res.status(400).json({ error: 'Sub-event name is required' });
        if (activity_pts !== undefined && activity_pts < 0) {
            return res.status(400).json({ error: 'Activity points cannot be negative' });
        }
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('orgusn').eq('eid', eventId).limit(1);
        if (eventError || !event?.length) return res.status(404).json({ error: 'Event not found' });
        if (event[0].orgusn !== req.session.userUSN) {
            return res.status(403).json({ error: 'Only the organizer can add sub-events' });
        }
        const { data: newSubEvent, error: insertError } = await supabaseAdmin
            .from('sub_event')
            .insert([{ eid: eventId, se_name, se_details: se_details || '', activity_pts: parseInt(activity_pts) || 0 }])
            .select().single();
        if (insertError) return res.status(500).json({ error: 'Failed to create sub-event' });
        res.status(201).json(newSubEvent);
    } catch (err) {
        res.status(500).json({ error: 'Error creating sub-event' });
    }
});

app.put('/api/sub-events/:seid', requireAuth, async (req, res) => {
    try {
        const seid = req.params.seid;
        const { se_name, activity_pts, se_details, password } = req.body;
        if (!password) return res.status(400).json({ error: 'Organizer PIN is required to confirm changes' });
        if (activity_pts !== undefined && activity_pts < 0) {
            return res.status(400).json({ error: 'Activity points cannot be negative' });
        }
        const { data: userData, error: userError } = await supabaseAdmin
            .from('student').select('organizer_pin').eq('usn', req.session.userUSN).single();
        if (userError || !userData) return res.status(401).json({ error: 'User verification failed' });
        if (!userData.organizer_pin) {
            return res.status(400).json({ error: 'You have not set an organizer PIN yet. Please set one in your profile.' });
        }
        const isValid = await bcrypt.compare(password, userData.organizer_pin);
        if (!isValid) return res.status(401).json({ error: 'Incorrect organizer PIN' });
        const { data: subEvent, error: fetchError } = await supabaseAdmin
            .from('sub_event').select('eid').eq('seid', seid).limit(1);
        if (fetchError || !subEvent?.length) return res.status(404).json({ error: 'Sub-event not found' });
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('orgusn').eq('eid', subEvent[0].eid).limit(1);
        if (eventError || !event?.length) return res.status(404).json({ error: 'Event not found' });
        if (event[0].orgusn !== req.session.userUSN) {
            return res.status(403).json({ error: 'Only the organizer can update sub-events' });
        }
        const updateData = {};
        if (se_name !== undefined) updateData.se_name = se_name;
        if (activity_pts !== undefined) updateData.activity_pts = parseInt(activity_pts) || 0;
        if (se_details !== undefined) updateData.se_details = se_details || '';
        const { data: updatedSubEvent, error: updateError } = await supabaseAdmin
            .from('sub_event').update(updateData).eq('seid', seid).select().single();
        if (updateError) return res.status(500).json({ error: 'Failed to update sub-event' });
        res.json(updatedSubEvent);
    } catch (err) {
        res.status(500).json({ error: 'Error updating sub-event' });
    }
});

app.delete('/api/sub-events/:seid', requireAuth, async (req, res) => {
    try {
        const seid = req.params.seid;
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'Organizer PIN is required to confirm deletion' });
        const { data: userData, error: userError } = await supabaseAdmin
            .from('student').select('organizer_pin').eq('usn', req.session.userUSN).single();
        if (userError || !userData) return res.status(401).json({ error: 'User verification failed' });
        if (!userData.organizer_pin) {
            return res.status(400).json({ error: 'You have not set an organizer PIN yet. Please set one in your profile.' });
        }
        const isValid = await bcrypt.compare(password, userData.organizer_pin);
        if (!isValid) return res.status(401).json({ error: 'Incorrect organizer PIN' });
        const { data: subEvent, error: fetchError } = await supabaseAdmin
            .from('sub_event').select('eid').eq('seid', seid).limit(1);
        if (fetchError || !subEvent?.length) return res.status(404).json({ error: 'Sub-event not found' });
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('orgusn').eq('eid', subEvent[0].eid).limit(1);
        if (eventError || !event?.length) return res.status(404).json({ error: 'Event not found' });
        if (event[0].orgusn !== req.session.userUSN) {
            return res.status(403).json({ error: 'Only the organizer can delete sub-events' });
        }
        const { count, error: countError } = await supabaseAdmin
            .from('sub_event').select('*', { count: 'exact', head: true }).eq('eid', subEvent[0].eid);
        if (countError) return res.status(500).json({ error: 'Database error' });
        if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last sub-event' });
        const { error: deleteError } = await supabaseAdmin.from('sub_event').delete().eq('seid', seid);
        if (deleteError) return res.status(500).json({ error: 'Failed to delete sub-event' });
        res.json({ success: true, message: 'Sub-event deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Error deleting sub-event' });
    }
});

// ==================== CLUBS & STUDENTS ====================

app.get('/api/clubs', requireAuth, async (req, res) => {
    try {
        const { data: rows, error } = await supabaseAdmin.from('club').select('cid, cname, clubdesc');
        if (error) return res.status(500).json({ error: 'Database error' });
        res.json({ clubs: rows || [], userUSN: req.session.userUSN });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching clubs' });
    }
});

app.get('/api/my-clubs', requireAuth, async (req, res) => {
    try {
        const { data: rows, error } = await supabaseAdmin
            .from('memberof').select('club:clubid (cid, cname, clubdesc, maxmembers)').eq('studentusn', req.session.userUSN);
        if (error) return res.status(500).json({ error: 'Database error' });
        res.json({ clubs: (rows || []).map(r => r.club).filter(Boolean), userUSN: req.session.userUSN });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching clubs' });
    }
});

// FIX: Restored mobno in students response (some frontend pages depend on it for display)
app.get('/api/students', requireAuth, async (req, res) => {
    try {
        const { data: rows, error } = await supabaseAdmin
            .from('student').select('usn, sname, sem, mobno, emailid');
        if (error) return res.status(500).json({ error: 'Database error' });
        res.json({ students: rows || [], currentUser: req.session.userUSN });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching students: ' + err.message });
    }
});

// ==================== ATTENDANCE (QR) ====================

function validateQRToken(seid, token, timestamp) {
    const now = Date.now();
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || now - ts > QR_TOKEN_VALIDITY_MS) return false;
    const payload = `${seid}:${timestamp}`;
    const expected = crypto.createHmac('sha256', QR_TOKEN_SECRET).update(payload).digest('hex').substring(0, 16);
    try {
        return crypto.timingSafeEqual(Buffer.from(token, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch (e) {
        return false;
    }
}

// FIX: Attendance marking — ensure supabaseAdmin is used so RLS doesn't block inserts
app.post('/api/mark-participant-attendance', requireAuth, async (req, res) => {
    try {
        const { seid, usn, token, timestamp } = req.body;
        if (usn !== req.session.userUSN) return res.status(403).json({ error: 'Unauthorized: USN mismatch' });
        if (!usn || !seid) return res.status(400).json({ error: 'USN and Sub-event ID are required' });
        if (!token || !timestamp) return res.status(400).json({ error: 'QR code is outdated. Please scan a fresh code.' });
        if (!validateQRToken(seid, token, timestamp)) {
            return res.status(401).json({ error: 'QR code has expired. Please ask the organizer to show a fresh code.' });
        }
        const { data: subEvent, error: subEventError } = await supabaseAdmin
            .from('sub_event').select('eid, se_name').eq('seid', seid).limit(1);
        if (subEventError || !subEvent?.length) return res.status(404).json({ error: 'Sub-event not found' });
        const eventId = subEvent[0].eid;
        const { data: existing } = await supabaseAdmin
            .from('participant').select('partstatus, payment_status').eq('partusn', usn).eq('parteid', eventId).limit(1);
        if (!existing?.length) return res.status(404).json({ error: 'You are not registered for this event' });
        if (existing[0].payment_status === 'pending_verification') {
            return res.status(400).json({ error: 'Your payment is pending verification by the organizer' });
        }
        const { data: existingAttendance } = await supabaseAdmin
            .from('sub_event_attendance').select('id').eq('seid', seid).eq('usn', usn).eq('role', 'participant').limit(1);
        if (existingAttendance?.length) {
            return res.status(400).json({ error: 'Attendance already marked for this sub-event' });
        }
        const { error: insertError } = await supabaseAdmin.from('sub_event_attendance')
            .insert([{ seid: parseInt(seid), eid: eventId, usn, role: 'participant' }]);
        if (insertError) {
            console.error('Attendance insert error:', insertError);
            return res.status(500).json({ error: 'Failed to mark attendance: ' + insertError.message });
        }
        const { count: scanCount } = await supabaseAdmin
            .from('sub_event_attendance').select('*', { count: 'exact', head: true })
            .eq('eid', eventId).eq('usn', usn).eq('role', 'participant');
        const { data: eventData } = await supabaseAdmin
            .from('event').select('min_part_scans').eq('eid', eventId).limit(1);
        const minPartScans = eventData?.[0]?.min_part_scans || 1;
        const thresholdMet = (scanCount || 0) >= minPartScans;
        if (thresholdMet) {
            const { error: updateError } = await supabaseAdmin.from('participant')
                .update({ partstatus: true }).eq('partusn', usn).eq('parteid', eventId);
            if (updateError) {
                console.error('Status update error:', updateError);
            }
        }
        console.log(`✅ Participant attendance: ${usn} for sub-event ${seid} (event ${eventId})`);
        res.json({
            success: true, message: 'Attendance marked successfully',
            attendanceCount: scanCount || 0, minRequired: minPartScans, thresholdMet
        });
    } catch (err) {
        console.error('Error marking participant attendance:', err);
        res.status(500).json({ error: 'Error marking attendance: ' + err.message });
    }
});

app.post('/api/mark-volunteer-attendance', requireAuth, async (req, res) => {
    try {
        const { seid, usn, token, timestamp } = req.body;
        if (usn !== req.session.userUSN) return res.status(403).json({ error: 'Unauthorized: USN mismatch' });
        if (!usn || !seid) return res.status(400).json({ error: 'USN and Sub-event ID are required' });
        if (!token || !timestamp) return res.status(400).json({ error: 'QR code is outdated. Please scan a fresh code.' });
        if (!validateQRToken(seid, token, timestamp)) {
            return res.status(401).json({ error: 'QR code has expired. Please ask the organizer to show a fresh code.' });
        }
        const { data: subEvent } = await supabaseAdmin
            .from('sub_event').select('eid, se_name').eq('seid', seid).limit(1);
        if (!subEvent?.length) return res.status(404).json({ error: 'Sub-event not found' });
        const eventId = subEvent[0].eid;
        const { data: existing } = await supabaseAdmin
            .from('volunteer').select('volnstatus').eq('volnusn', usn).eq('volneid', eventId).limit(1);
        if (!existing?.length) return res.status(404).json({ error: 'You are not registered as a volunteer for this event' });
        const { data: existingAttendance } = await supabaseAdmin
            .from('sub_event_attendance').select('id').eq('seid', seid).eq('usn', usn).eq('role', 'volunteer').limit(1);
        if (existingAttendance?.length) {
            return res.status(400).json({ error: 'Attendance already marked for this sub-event' });
        }
        const { error: insertError } = await supabaseAdmin.from('sub_event_attendance')
            .insert([{ seid: parseInt(seid), eid: eventId, usn, role: 'volunteer' }]);
        if (insertError) {
            console.error('Volunteer attendance insert error:', insertError);
            return res.status(500).json({ error: 'Failed to mark attendance: ' + insertError.message });
        }
        const { count: scanCount } = await supabaseAdmin
            .from('sub_event_attendance').select('*', { count: 'exact', head: true })
            .eq('eid', eventId).eq('usn', usn).eq('role', 'volunteer');
        const { data: eventData } = await supabaseAdmin
            .from('event').select('min_voln_scans').eq('eid', eventId).limit(1);
        const minVolnScans = eventData?.[0]?.min_voln_scans || 1;
        const thresholdMet = (scanCount || 0) >= minVolnScans;
        if (thresholdMet) {
            await supabaseAdmin.from('volunteer').update({ volnstatus: true })
                .eq('volnusn', usn).eq('volneid', eventId);
        }
        console.log(`✅ Volunteer attendance: ${usn} for sub-event ${seid} (event ${eventId})`);
        res.json({
            success: true, message: 'Attendance marked successfully',
            attendanceCount: scanCount || 0, minRequired: minVolnScans, thresholdMet
        });
    } catch (err) {
        console.error('Error marking volunteer attendance:', err);
        res.status(500).json({ error: 'Error marking attendance: ' + err.message });
    }
});

// FIX: Kept legacy scan-qr endpoint for backward compat with old QR codes
app.get('/api/scan-qr', async (req, res) => {
    try {
        const { usn, eid } = req.query;
        if (!usn || !eid) return res.status(400).json({ error: 'USN and Event ID are required' });
        const { data: existing } = await supabaseAdmin
            .from('participant').select('*').eq('partusn', usn).eq('parteid', eid).limit(1);
        if (!existing || existing.length === 0) {
            return res.status(404).json({ error: 'Participant not found for this event' });
        }
        if (existing[0].partstatus === true) {
            return res.status(400).json({ error: 'Participant already checked in' });
        }
        await supabaseAdmin.from('participant').update({ partstatus: true }).eq('partusn', usn).eq('parteid', eid);
        res.json({ success: true, message: 'Participant checked in successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Error updating participant status: ' + err.message });
    }
});

// ==================== QR TOKEN GENERATION ====================

app.get('/api/sub-events/:seid/qr-token', requireAuth, async (req, res) => {
    try {
        const seid = req.params.seid;
        const userUSN = req.session.userUSN;
        const { data: subEvent, error } = await supabaseAdmin
            .from('sub_event').select('eid, se_name').eq('seid', seid).limit(1);
        if (error || !subEvent?.length) return res.status(404).json({ error: 'Sub-event not found' });
        const eventId = subEvent[0].eid;
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('orgusn').eq('eid', eventId).limit(1);
        if (eventError || !event?.length) return res.status(404).json({ error: 'Event not found' });
        if (event[0].orgusn !== userUSN) return res.status(403).json({ error: 'Only the organizer can generate QR tokens' });
        const timestamp = Date.now().toString();
        const payload = `${seid}:${timestamp}`;
        const token = crypto.createHmac('sha256', QR_TOKEN_SECRET).update(payload).digest('hex').substring(0, 16);
        res.json({ token, timestamp, seid, eid: eventId, seName: subEvent[0].se_name });
    } catch (err) {
        console.error('QR token generation error:', err);
        res.status(500).json({ error: 'Failed to generate token' });
    }
});

// ==================== ORGANIZER PIN ====================

app.post('/api/set-organizer-pin', requireAuth, async (req, res) => {
    try {
        const { newPin, confirmPin } = req.body;
        if (!newPin || !/^\d{4,6}$/.test(newPin))
            return res.status(400).json({ error: 'PIN must be 4 to 6 digits' });
        if (newPin !== confirmPin)
            return res.status(400).json({ error: 'PINs do not match' });
        const { data: userData } = await supabaseAdmin
            .from('student').select('organizer_pin').eq('usn', req.session.userUSN).single();
        if (userData?.organizer_pin)
            return res.status(400).json({ error: 'PIN already set. Use the change PIN flow.' });
        const hashedPin = await bcrypt.hash(newPin, 10);
        await supabaseAdmin.from('student').update({ organizer_pin: hashedPin }).eq('usn', req.session.userUSN);
        res.json({ success: true, message: 'Organizer PIN set successfully' });
    } catch (err) {
        console.error('Error setting PIN:', err);
        res.status(500).json({ error: 'Failed to set PIN' });
    }
});

app.post('/api/request-pin-otp', requireAuth, async (req, res) => {
    try {
        const { data: userData, error: userError } = await supabaseAdmin
            .from('student').select('sname, emailid, organizer_pin').eq('usn', req.session.userUSN).single();
        if (userError || !userData) return res.status(404).json({ error: 'User not found' });
        if (!userData.organizer_pin) return res.status(400).json({ error: 'No PIN set. Use Set PIN instead.' });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiry = new Date(Date.now() + 5 * 60 * 1000);
        const hashedOtp = await bcrypt.hash(otp, 10);
        await supabaseAdmin.from('student').update({
            pin_otp: hashedOtp, pin_otp_expiry: expiry.toISOString()
        }).eq('usn', req.session.userUSN);
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = 'Your Organizer PIN Change OTP - FLO';
        sendSmtpEmail.sender = { name: 'FLO', email: 'epass@flobms.com' };
        sendSmtpEmail.to = [{ email: userData.emailid, name: userData.sname }];
        sendSmtpEmail.htmlContent = `
            <html><body style="font-family: Arial, sans-serif; color: #333; background: #f5f5f5; padding: 20px;">
                <div style="max-width: 500px; margin: 0 auto; background: #fff; border: 3px solid #0D0D0D; padding: 32px; box-shadow: 5px 5px 0 #0D0D0D;">
                    <h2 style="color: #0D0D0D; font-family: monospace; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 8px;">FLO E-Pass</h2>
                    <div style="height: 4px; background: #FFD600; width: 40px; margin-bottom: 24px;"></div>
                    <p style="margin: 0 0 8px;">Hello <strong>${userData.sname}</strong>,</p>
                    <p style="margin: 0 0 24px; color: #555;">Your OTP to change your Organizer PIN is:</p>
                    <div style="background: #0D0D0D; color: #FFD600; font-family: monospace; font-size: 36px; font-weight: 700; letter-spacing: 12px; text-align: center; padding: 20px; margin-bottom: 24px;">${otp}</div>
                    <p style="margin: 0 0 8px; color: #555; font-size: 13px;">This OTP is valid for <strong>5 minutes</strong> only.</p>
                    <p style="margin: 0; color: #999; font-size: 12px; font-family: monospace; text-transform: uppercase; letter-spacing: 1px;">If you did not request this, ignore this email. Your PIN has not changed.</p>
                </div>
            </body></html>
        `;
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`✅ PIN OTP sent to ${userData.emailid}`);
        res.json({ success: true, message: `OTP sent to ${userData.emailid}. Valid for 5 minutes.` });
    } catch (err) {
        console.error('Error sending PIN OTP:', err);
        res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
    }
});

app.post('/api/verify-pin-otp', requireAuth, async (req, res) => {
    try {
        const { otp } = req.body;
        if (!otp || !/^\d{6}$/.test(otp))
            return res.status(400).json({ error: 'Please enter a valid 6-digit OTP' });
        const { data: userData, error: userError } = await supabaseAdmin
            .from('student').select('pin_otp, pin_otp_expiry').eq('usn', req.session.userUSN).single();
        if (userError || !userData) return res.status(404).json({ error: 'User not found' });
        if (!userData.pin_otp || !userData.pin_otp_expiry)
            return res.status(400).json({ error: 'No OTP requested. Please request a new OTP first.' });
        if (new Date(userData.pin_otp_expiry) < new Date()) {
            await supabaseAdmin.from('student').update({ pin_otp: null, pin_otp_expiry: null }).eq('usn', req.session.userUSN);
            return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
        }
        const isValid = await bcrypt.compare(otp, userData.pin_otp);
        if (!isValid) return res.status(401).json({ error: 'Incorrect OTP. Please try again.' });
        await supabaseAdmin.from('student').update({ pin_otp: null, pin_otp_expiry: null }).eq('usn', req.session.userUSN);
        res.json({ success: true, message: 'OTP verified. You can now set your new PIN.' });
    } catch (err) {
        console.error('Error verifying PIN OTP:', err);
        res.status(500).json({ error: 'Failed to verify OTP. Please try again.' });
    }
});

app.post('/api/reset-organizer-pin', requireAuth, async (req, res) => {
    try {
        const { newPin, confirmPin } = req.body;
        if (!newPin) return res.status(400).json({ error: 'New PIN is required' });
        if (!/^\d+$/.test(newPin)) return res.status(400).json({ error: 'PIN must contain only digits' });
        if (newPin.length < 4) return res.status(400).json({ error: 'PIN must be at least 4 digits' });
        if (newPin.length > 6) return res.status(400).json({ error: 'PIN must be at most 6 digits' });
        if (newPin !== confirmPin) return res.status(400).json({ error: 'PINs do not match' });
        const weakPins = ['123456', '654321', '111111', '000000', '1234', '0000', '1111', '9999', '123123', '112233'];
        if (weakPins.includes(newPin)) return res.status(400).json({ error: 'This PIN is too common. Please choose a stronger PIN.' });
        if (/^(\d)\1+$/.test(newPin)) return res.status(400).json({ error: 'PIN cannot be all the same digit' });
        const digits = newPin.split('').map(Number);
        let asc = true, desc = true;
        for (let i = 1; i < digits.length; i++) {
            if (digits[i] !== digits[i - 1] + 1) asc = false;
            if (digits[i] !== digits[i - 1] - 1) desc = false;
        }
        if (asc || desc) return res.status(400).json({ error: 'PIN cannot be sequential digits (e.g. 1234 or 9876)' });
        const hashedPin = await bcrypt.hash(newPin, 10);
        await supabaseAdmin.from('student').update({ organizer_pin: hashedPin }).eq('usn', req.session.userUSN);
        console.log(`✅ Organizer PIN changed for: ${req.session.userUSN}`);
        res.json({ success: true, message: 'Organizer PIN changed successfully' });
    } catch (err) {
        console.error('Error changing PIN:', err);
        res.status(500).json({ error: 'Failed to change PIN. Please try again.' });
    }
});

// ==================== UPI PAYMENT ====================

// Register via UPI (paid individual)
app.post('/api/events/:eventId/register-upi', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { transaction_id } = req.body;
        if (!transaction_id) return res.status(400).json({ error: 'Transaction ID is required' });
        const { data: existing } = await supabaseAdmin
            .from('participant').select('*').eq('partusn', userUSN).eq('parteid', eventId).limit(1);
        if (existing && existing.length > 0) {
            return res.status(400).json({ error: 'You are already registered for this event' });
        }
        const { data: eventData, error: eventError } = await supabaseAdmin
            .from('event').select('regfee, maxpart, orgusn').eq('eid', eventId).limit(1);
        if (eventError) return res.status(500).json({ error: 'Database error' });
        if (eventData?.[0]?.orgusn === userUSN) {
            return res.status(403).json({ error: 'You cannot register as a participant in an event you are organizing' });
        }
        const { data: volCheck } = await supabaseAdmin
            .from('volunteer').select('volnusn').eq('volnusn', userUSN).eq('volneid', eventId).limit(1);
        if (volCheck && volCheck.length > 0) {
            return res.status(403).json({ error: 'You are already volunteering for this event. Volunteers cannot also register as participants.' });
        }
        const amount = eventData?.[0]?.regfee || 0;
        const maxPart = eventData?.[0]?.maxpart || 0;
        if (amount <= 0) return res.status(400).json({ error: 'This is not a paid event' });
        if (maxPart > 0) {
            const { count } = await supabaseAdmin
                .from('participant').select('*', { count: 'exact', head: true }).eq('parteid', eventId);
            if (count >= maxPart) return res.status(400).json({ error: 'Event is full' });
        }
        await supabaseAdmin.from('payment').insert([{
            usn: userUSN, event_id: eventId, amount, status: 'pending_verification', upi_transaction_id: transaction_id
        }]);
        await supabaseAdmin.from('participant').insert([{
            partusn: userUSN, parteid: eventId, partstatus: false, payment_status: 'pending_verification'
        }]);
        console.log(`✅ UPI registration submitted: ${userUSN} for event ${eventId}`);
        res.json({ success: true, message: 'Registration submitted! Your payment is pending verification by the organizer.', userUSN });
    } catch (err) {
        console.error('Error in UPI registration:', err);
        res.status(500).json({ error: 'Error submitting registration' });
    }
});

// ==================== PAYMENT VERIFICATION ====================

app.post('/api/payments/verify', requireAuth, async (req, res) => {
    try {
        const { participantUSN, eventId } = req.body;
        const organizerUSN = req.session.userUSN;
        if (!participantUSN || !eventId) {
            return res.status(400).json({ error: 'Participant USN and Event ID are required' });
        }
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('orgusn, is_team').eq('eid', eventId).limit(1);
        if (eventError || !event || event.length === 0) return res.status(404).json({ error: 'Event not found' });
        if (event[0].orgusn !== organizerUSN) {
            return res.status(403).json({ error: 'Not authorized to verify payments for this event' });
        }
        const isTeamEvent = event[0].is_team;
        if (isTeamEvent) {
            const { data: teamData } = await supabaseAdmin
                .from('team').select('id').eq('event_id', eventId).eq('leader_usn', participantUSN).limit(1);
            const teamId = teamData?.[0]?.id;
            if (teamId) {
                const { data: teamMembers, error: teamMembersError } = await supabaseAdmin
                    .from('team_members').select('student_usn').eq('team_id', teamId).eq('join_status', true);
                if (teamMembersError) return res.status(500).json({ error: 'Failed to fetch team members' });
                const allTeamUSNs = teamMembers.map(m => m.student_usn);
                await supabaseAdmin.from('payment').update({ status: 'verified' })
                    .eq('event_id', eventId).eq('usn', participantUSN).eq('status', 'pending_verification');
                await supabaseAdmin.from('participant').update({ payment_status: 'verified' })
                    .in('partusn', allTeamUSNs).eq('parteid', eventId);
                // Mark team registration complete AFTER payment is verified
                await supabaseAdmin.from('team').update({ registration_complete: true }).eq('id', teamId);
                console.log(`✅ Payment verified for team ${teamId} (${allTeamUSNs.length} members)`);
                return res.json({
                    success: true,
                    message: `Payment verified for entire team (${allTeamUSNs.length} members)!`,
                    verifiedCount: allTeamUSNs.length
                });
            }
        }
        await supabaseAdmin.from('payment').update({ status: 'verified' })
            .eq('usn', participantUSN).eq('event_id', eventId).eq('status', 'pending_verification');
        await supabaseAdmin.from('participant').update({ payment_status: 'verified' })
            .eq('partusn', participantUSN).eq('parteid', eventId);
        console.log(`✅ Payment verified: ${participantUSN} for event ${eventId} by ${organizerUSN}`);
        return res.json({ success: true, message: 'Payment verified successfully!' });
    } catch (err) {
        console.error('Error verifying payment:', err);
        res.status(500).json({ error: 'Error verifying payment' });
    }
});

app.get('/api/events/:eventId/pending-payments', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('orgusn, ename, is_team').eq('eid', eventId).limit(1);
        if (eventError || !event || event.length === 0) return res.status(404).json({ error: 'Event not found' });
        if (event[0].orgusn !== userUSN) return res.status(403).json({ error: 'Not authorized to view payments for this event' });
        const isTeamEvent = event[0].is_team;
        let paymentsToShow = [];
        if (isTeamEvent) {
            const { data: pendingPayments, error: paymentsError } = await supabaseAdmin
                .from('payment')
                .select('usn, amount, upi_transaction_id, created_at, status, student:usn (sname, emailid, mobno)')
                .eq('event_id', eventId).eq('status', 'pending_verification');
            if (paymentsError) return res.status(500).json({ error: 'Database error' });
            for (const payment of pendingPayments || []) {
                const { data: teamData } = await supabaseAdmin
                    .from('team').select('id, team_name, leader_usn')
                    .eq('event_id', eventId).eq('leader_usn', payment.usn).limit(1);
                if (teamData && teamData.length > 0) {
                    const { count: memberCount } = await supabaseAdmin
                        .from('team_members').select('*', { count: 'exact', head: true })
                        .eq('team_id', teamData[0].id).eq('join_status', true);
                    paymentsToShow.push({
                        partusn: payment.usn, studentName: payment.student?.sname || 'Unknown',
                        studentEmail: payment.student?.emailid || 'N/A', studentMobile: payment.student?.mobno || 'N/A',
                        transactionId: payment.upi_transaction_id || 'N/A', amount: payment.amount || 0,
                        submittedAt: payment.created_at || null, teamName: teamData[0].team_name || 'Unknown Team',
                        teamMemberCount: memberCount || 1, isTeamLeader: true
                    });
                }
            }
        } else {
            const { data: pendingPayments, error: paymentsError } = await supabaseAdmin
                .from('payment')
                .select('usn, amount, upi_transaction_id, created_at, status, student:usn (sname, emailid, mobno)')
                .eq('event_id', eventId).eq('status', 'pending_verification');
            if (paymentsError) return res.status(500).json({ error: 'Database error' });
            paymentsToShow = (pendingPayments || []).map(payment => ({
                partusn: payment.usn, studentName: payment.student?.sname || 'Unknown',
                studentEmail: payment.student?.emailid || 'N/A', studentMobile: payment.student?.mobno || 'N/A',
                transactionId: payment.upi_transaction_id || 'N/A', amount: payment.amount || 0,
                submittedAt: payment.created_at || null, teamName: null, isTeamLeader: false
            }));
        }
        console.log(`✅ Found ${paymentsToShow.length} pending payments for event ${eventId}`);
        res.json({ success: true, pendingPayments: paymentsToShow, isTeamEvent });
    } catch (err) {
        console.error('Error fetching pending payments:', err);
        res.status(500).json({ error: 'Error fetching pending payments' });
    }
});

// ==================== TEAM ENDPOINTS ====================

// Create team
app.post('/api/events/:eventId/create-team', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { teamName, memberUSNs } = req.body;
        if (!teamName || !Array.isArray(memberUSNs)) {
            return res.status(400).json({ error: 'Team name and member USNs are required' });
        }
        const { data: event, error: eventError } = await supabaseAdmin
            .from('event').select('eid, ename, is_team, min_team_size, max_team_size, regfee, orgusn').eq('eid', eventId).limit(1);
        if (eventError || !event || event.length === 0) return res.status(404).json({ error: 'Event not found' });
        if (!event[0].is_team) return res.status(400).json({ error: 'This is not a team event' });
        if (event[0].orgusn === userUSN) {
            return res.status(403).json({ error: 'Event organizers cannot register as participants in their own event' });
        }
        const { data: volCheck } = await supabaseAdmin
            .from('volunteer').select('volnusn').eq('volnusn', userUSN).eq('volneid', eventId).limit(1);
        if (volCheck && volCheck.length > 0) {
            return res.status(403).json({ error: 'You are volunteering for this event. Volunteers cannot also register as participants.' });
        }
        const minSize = event[0].min_team_size;
        const maxSize = event[0].max_team_size;
        const totalMembers = memberUSNs.length + 1;
        if (maxSize && totalMembers > maxSize) {
            return res.status(400).json({ error: `Team size cannot exceed ${maxSize} members (including leader)` });
        }
        const { data: existingTeam } = await supabaseAdmin
            .from('team_members').select('team_id, join_status, team:team_id(event_id, leader_usn)').eq('student_usn', userUSN);
        if (existingTeam && existingTeam.length > 0) {
            const joinedTeam = existingTeam.find(tm => tm.join_status === true && tm.team?.event_id === parseInt(eventId));
            if (joinedTeam) {
                return res.status(400).json({ error: 'You have already joined a team for this event. Leave that team first to create a new one.' });
            }
        }
        if (memberUSNs.length > 0) {
            const { data: students, error: studentError } = await supabaseAdmin
                .from('student').select('usn, sname').in('usn', memberUSNs);
            if (studentError || !students || students.length !== memberUSNs.length) {
                return res.status(400).json({ error: 'One or more member USNs are invalid' });
            }
            if (memberUSNs.includes(event[0].orgusn)) {
                return res.status(400).json({ error: 'Cannot add the event organizer as a team member' });
            }
            const { data: memberVolCheck } = await supabaseAdmin
                .from('volunteer').select('volnusn').in('volnusn', memberUSNs).eq('volneid', eventId);
            if (memberVolCheck && memberVolCheck.length > 0) {
                return res.status(400).json({ error: `${memberVolCheck[0].volnusn} is volunteering for this event and cannot be added as a team member` });
            }
            const { data: memberTeamCheck } = await supabaseAdmin
                .from('team_members').select('student_usn, join_status, team:team_id(event_id)')
                .in('student_usn', memberUSNs).eq('join_status', true);
            if (memberTeamCheck && memberTeamCheck.length > 0) {
                const conflicts = memberTeamCheck.filter(m => m.team?.event_id === parseInt(eventId));
                if (conflicts.length > 0) {
                    return res.status(400).json({ error: `Member ${conflicts[0].student_usn} has already joined another team for this event` });
                }
            }
        }
        const { data: teamData, error: teamError } = await supabaseAdmin
            .from('team').insert([{ team_name: teamName, leader_usn: userUSN, event_id: eventId, registration_complete: false }]).select('id');
        if (teamError || !teamData || teamData.length === 0) {
            console.error('Error creating team:', teamError);
            return res.status(500).json({ error: 'Failed to create team' });
        }
        const teamId = teamData[0].id;
        const teamMembersToInsert = [{ team_id: teamId, student_usn: userUSN, join_status: true }];
        memberUSNs.forEach(usn => teamMembersToInsert.push({ team_id: teamId, student_usn: usn, join_status: false }));
        const { error: membersError } = await supabaseAdmin.from('team_members').insert(teamMembersToInsert);
        if (membersError) {
            console.error('Error adding team members:', membersError);
            await supabaseAdmin.from('team').delete().eq('id', teamId);
            return res.status(500).json({ error: 'Failed to add team members' });
        }
        console.log(`✅ Team created: ${teamName} (ID: ${teamId}) by ${userUSN}`);
        res.json({
            success: true, message: 'Team created successfully! Invitations sent to members.',
            teamId, minSize, currentSize: 1, canRegister: minSize <= 1
        });
    } catch (err) {
        console.error('Error creating team:', err);
        res.status(500).json({ error: 'Error creating team' });
    }
});

app.post('/api/events/:eventId/join-team', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { leaderUSN } = req.body;
        if (!leaderUSN) return res.status(400).json({ error: 'Team leader USN is required' });
        const { data: existingMembership } = await supabaseAdmin
            .from('team_members').select('team_id, team:team_id(event_id, registration_complete)').eq('student_usn', userUSN);
        if (existingMembership && existingMembership.length > 0) {
            const inEventTeam = existingMembership.find(m => m.team?.event_id === parseInt(eventId));
            if (inEventTeam) {
                if (inEventTeam.team.registration_complete) return res.status(400).json({ error: 'Your team is already registered for this event' });
                return res.status(400).json({ error: 'You are already part of a team for this event' });
            }
        }
        const { data: team, error: teamError } = await supabaseAdmin
            .from('team').select('id, team_name, registration_complete')
            .eq('leader_usn', leaderUSN).eq('event_id', eventId).limit(1);
        if (teamError || !team || team.length === 0) return res.status(404).json({ error: 'Team not found. Please check the team leader USN.' });
        const teamId = team[0].id;
        if (team[0].registration_complete) return res.status(400).json({ error: 'This team has already completed registration' });
        const { data: membership } = await supabaseAdmin
            .from('team_members').select('join_status').eq('team_id', teamId).eq('student_usn', userUSN).limit(1);
        if (!membership || membership.length === 0) return res.status(403).json({ error: 'You are not invited to this team' });
        if (membership[0].join_status) return res.status(400).json({ error: 'You have already joined this team' });
        await supabaseAdmin.from('team_members').update({ join_status: true }).eq('team_id', teamId).eq('student_usn', userUSN);
        res.json({ success: true, message: `Successfully joined team "${team[0].team_name}"!`, teamId });
    } catch (err) {
        res.status(500).json({ error: 'Error joining team' });
    }
});

app.get('/api/events/:eventId/team-status', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { data: event } = await supabaseAdmin
            .from('event').select('is_team, min_team_size, max_team_size, regfee').eq('eid', eventId).limit(1);
        if (!event || event.length === 0) return res.status(404).json({ error: 'Event not found' });
        if (!event[0].is_team) return res.json({ isTeamEvent: false });
        const { data: leaderTeam } = await supabaseAdmin
            .from('team').select('id, team_name, registration_complete').eq('leader_usn', userUSN).eq('event_id', eventId).limit(1);
        if (leaderTeam && leaderTeam.length > 0) {
            const teamId = leaderTeam[0].id;
            const { data: members } = await supabaseAdmin
                .from('team_members').select('student_usn, join_status, student:student_usn(sname)').eq('team_id', teamId);
            const joinedCount = members?.filter(m => m.join_status).length || 0;
            return res.json({
                isTeamEvent: true, isLeader: true, hasJoinedTeam: true,
                teamId, teamName: leaderTeam[0].team_name, members: members || [],
                joinedCount, minSize: event[0].min_team_size, maxSize: event[0].max_team_size,
                canRegister: joinedCount >= event[0].min_team_size,
                registrationComplete: leaderTeam[0].registration_complete, regFee: event[0].regfee
            });
        }
        const { data: memberTeam } = await supabaseAdmin
            .from('team_members')
            .select('team_id, join_status, team:team_id(id, team_name, leader_usn, registration_complete, event_id, leader:leader_usn(sname))')
            .eq('student_usn', userUSN).eq('join_status', true);
        if (memberTeam && memberTeam.length > 0) {
            const teamInEvent = memberTeam.find(m => m.team?.event_id === parseInt(eventId));
            if (teamInEvent) {
                const { data: teamDetails } = await supabaseAdmin
                    .from('team_members').select('student_usn, join_status, student:student_usn(sname)').eq('team_id', teamInEvent.team.id);
                return res.json({
                    isTeamEvent: true, isLeader: false, isMember: true, hasJoinedTeam: true,
                    teamId: teamInEvent.team.id, teamName: teamInEvent.team.team_name,
                    leaderUSN: teamInEvent.team.leader_usn, leaderName: teamInEvent.team.leader?.sname,
                    registrationComplete: teamInEvent.team.registration_complete,
                    minSize: event[0].min_team_size, maxSize: event[0].max_team_size,
                    members: teamDetails || [], joinedCount: teamDetails?.filter(m => m.join_status).length || 0
                });
            }
        }
        res.json({
            isTeamEvent: true, isLeader: false, isMember: false, hasJoinedTeam: false,
            minSize: event[0].min_team_size, maxSize: event[0].max_team_size, regFee: event[0].regfee
        });
    } catch (err) {
        console.error('Error getting team status:', err);
        res.status(500).json({ error: 'Error getting team status' });
    }
});

// Register team (free events)
app.post('/api/events/:eventId/register-team', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { data: team, error: teamError } = await supabaseAdmin
            .from('team').select('id, registration_complete, event:event_id(regfee, min_team_size, maxpart)')
            .eq('leader_usn', userUSN).eq('event_id', eventId).limit(1);
        if (teamError || !team || team.length === 0) return res.status(404).json({ error: 'Team not found or you are not the team leader' });
        if (team[0].registration_complete) return res.status(400).json({ error: 'Team is already registered for this event' });
        const teamId = team[0].id;
        const regFee = team[0].event?.regfee || 0;
        const minSize = team[0].event?.min_team_size || 2;
        const maxTeams = team[0].event?.maxpart || 0;
        const { data: members } = await supabaseAdmin
            .from('team_members').select('student_usn, join_status').eq('team_id', teamId).eq('join_status', true);
        const joinedCount = members?.length || 0;
        if (joinedCount < minSize) {
            return res.status(400).json({ error: `Minimum ${minSize} members must join before registration. Currently ${joinedCount} members have joined.` });
        }
        if (maxTeams > 0) {
            const { count } = await supabaseAdmin
                .from('team').select('*', { count: 'exact', head: true }).eq('event_id', eventId).eq('registration_complete', true);
            if (count >= maxTeams) return res.status(400).json({ error: `Event is full. Maximum ${maxTeams} teams allowed.` });
        }
        if (regFee > 0) {
            return res.json({ success: true, requiresPayment: true, message: 'Payment required for team registration', teamId, regFee });
        }
        await supabaseAdmin.from('team').update({ registration_complete: true }).eq('id', teamId);
        const participantsToInsert = members.map(m => ({
            partusn: m.student_usn, parteid: eventId, partstatus: false, payment_status: 'free', team_id: teamId
        }));
        const { error: participantError } = await supabaseAdmin
            .from('participant').upsert(participantsToInsert, { onConflict: 'partusn,parteid' });
        if (participantError) {
            console.error('Error adding participants:', participantError);
            await supabaseAdmin.from('team').update({ registration_complete: false }).eq('id', teamId);
            return res.status(500).json({ error: 'Failed to add team members as participants' });
        }
        res.json({ success: true, message: 'Team registered successfully!', teamId, userUSN });
    } catch (err) {
        console.error('Error registering team:', err);
        res.status(500).json({ error: 'Error registering team' });
    }
});

// Register team via UPI (paid)
app.post('/api/events/:eventId/register-team-upi', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { transaction_id } = req.body;
        if (!transaction_id) return res.status(400).json({ error: 'Transaction ID is required' });
        const { data: team, error: teamError } = await supabaseAdmin
            .from('team').select('id, registration_complete, event:event_id(regfee, min_team_size, maxpart)')
            .eq('leader_usn', userUSN).eq('event_id', eventId).limit(1);
        if (teamError || !team || team.length === 0) return res.status(404).json({ error: 'Team not found or you are not the team leader' });
        if (team[0].registration_complete) return res.status(400).json({ error: 'Team is already registered for this event' });
        const teamId = team[0].id;
        const regFee = team[0].event?.regfee || 0;
        const minSize = team[0].event?.min_team_size || 2;
        const maxTeams = team[0].event?.maxpart || 0;
        if (regFee <= 0) return res.status(400).json({ error: 'This is not a paid event' });
        const { data: members, error: memberError } = await supabaseAdmin
            .from('team_members').select('student_usn, join_status').eq('team_id', teamId).eq('join_status', true);
        if (memberError) return res.status(500).json({ error: 'Failed to get team members' });
        const joinedCount = members?.length || 0;
        if (joinedCount < minSize) return res.status(400).json({ error: `Minimum ${minSize} members must join before registration.` });
        if (maxTeams > 0) {
            const { count } = await supabaseAdmin
                .from('team').select('*', { count: 'exact', head: true }).eq('event_id', eventId).eq('registration_complete', true);
            if (count >= maxTeams) return res.status(400).json({ error: `Event is full. Maximum ${maxTeams} teams allowed.` });
        }
        await supabaseAdmin.from('payment').insert([{
            usn: userUSN, event_id: eventId, amount: regFee, status: 'pending_verification', upi_transaction_id: transaction_id
        }]);
        // NOTE: registration_complete is NOT set here — set in /api/payments/verify after organizer confirms
        const participantsToInsert = members.map(m => ({
            partusn: m.student_usn, parteid: eventId, partstatus: false, payment_status: 'pending_verification', team_id: teamId
        }));
        const { error: participantError } = await supabaseAdmin
            .from('participant').upsert(participantsToInsert, { onConflict: 'partusn,parteid' });
        if (participantError) return res.status(500).json({ error: 'Failed to register team members' });
        res.json({ success: true, message: 'Team registration submitted! Your payment is pending verification.', userUSN });
    } catch (err) {
        console.error('Error registering team with UPI:', err);
        res.status(500).json({ error: 'Error registering team' });
    }
});

// Add members to team
app.post('/api/teams/:teamId/add-members', requireAuth, async (req, res) => {
    try {
        const teamId = req.params.teamId;
        const userUSN = req.session.userUSN;
        const { memberUSNs } = req.body;
        if (!Array.isArray(memberUSNs) || memberUSNs.length === 0) return res.status(400).json({ error: 'Member USNs are required' });
        const { data: team } = await supabaseAdmin
            .from('team').select('leader_usn, event_id, registration_complete, event:event_id(max_team_size)').eq('id', teamId).limit(1);
        if (!team || team.length === 0) return res.status(404).json({ error: 'Team not found' });
        if (team[0].leader_usn !== userUSN) return res.status(403).json({ error: 'Only team leader can add members' });
        if (team[0].registration_complete) return res.status(400).json({ error: 'Cannot add members to a registered team' });
        const { count: currentSize } = await supabaseAdmin
            .from('team_members').select('*', { count: 'exact', head: true }).eq('team_id', teamId);
        const maxSize = team[0].event?.max_team_size;
        if (maxSize && (currentSize + memberUSNs.length) > maxSize) {
            return res.status(400).json({ error: `Cannot exceed maximum team size of ${maxSize}` });
        }
        const { data: students } = await supabaseAdmin.from('student').select('usn').in('usn', memberUSNs);
        if (!students || students.length !== memberUSNs.length) return res.status(400).json({ error: 'One or more member USNs are invalid' });
        const { data: eventData } = await supabaseAdmin.from('event').select('orgusn').eq('eid', team[0].event_id).single();
        if (memberUSNs.includes(eventData?.orgusn)) {
            return res.status(400).json({ error: 'Cannot add the event organizer as a team member' });
        }
        const { data: volCheck } = await supabaseAdmin
            .from('volunteer').select('volnusn').in('volnusn', memberUSNs).eq('volneid', team[0].event_id);
        if (volCheck && volCheck.length > 0) {
            return res.status(400).json({ error: `${volCheck[0].volnusn} is volunteering for this event and cannot be added as a team member` });
        }
        const { data: conflictCheck } = await supabaseAdmin
            .from('team_members').select('student_usn, team:team_id(event_id)').in('student_usn', memberUSNs);
        if (conflictCheck && conflictCheck.length > 0) {
            const conflicts = conflictCheck.filter(m => m.team?.event_id === team[0].event_id);
            if (conflicts.length > 0) return res.status(400).json({ error: `Member ${conflicts[0].student_usn} is already in another team` });
        }
        const { error: insertError } = await supabaseAdmin.from('team_members')
            .insert(memberUSNs.map(usn => ({ team_id: teamId, student_usn: usn, join_status: false })));
        if (insertError) return res.status(500).json({ error: 'Failed to add members' });
        res.json({ success: true, message: 'Members added successfully!' });
    } catch (err) {
        res.status(500).json({ error: 'Error adding members' });
    }
});

app.get('/api/events/:eventId/my-invites', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;
        const { data: invites, error } = await supabaseAdmin
            .from('team_members')
            .select('team_id, join_status, team:team_id (id, team_name, leader_usn, event_id, registration_complete, leader:leader_usn(sname))')
            .eq('student_usn', userUSN).eq('join_status', false);
        if (error) return res.status(500).json({ error: 'Database error' });
        const eventInvites = (invites || [])
            .filter(invite => invite.team?.event_id === parseInt(eventId))
            .map(invite => ({
                teamId: invite.team.id, teamName: invite.team.team_name,
                leaderUSN: invite.team.leader_usn, leaderName: invite.team.leader?.sname || 'Unknown',
                joinStatus: invite.join_status, registrationComplete: invite.team.registration_complete
            }));
        res.json({ success: true, invites: eventInvites });
    } catch (err) {
        res.status(500).json({ error: 'Error fetching invites' });
    }
});

// Confirm join team
app.post('/api/teams/:teamId/confirm-join', requireAuth, async (req, res) => {
    try {
        const teamId = req.params.teamId;
        const userUSN = req.session.userUSN;
        console.log(`Confirming join for user ${userUSN} to team ${teamId}`);
        const { data: membership, error: membershipError } = await supabaseAdmin
            .from('team_members')
            .select('join_status, team:team_id(event_id, registration_complete, team_name)')
            .eq('team_id', teamId).eq('student_usn', userUSN).limit(1);
        if (membershipError) return res.status(500).json({ error: 'Database error' });
        if (!membership || membership.length === 0) return res.status(404).json({ error: 'You are not invited to this team' });
        if (membership[0].join_status) return res.status(400).json({ error: 'You have already joined this team' });
        if (membership[0].team.registration_complete) return res.status(400).json({ error: 'This team has already completed registration' });
        const { data: volCheck } = await supabaseAdmin
            .from('volunteer').select('volnusn').eq('volnusn', userUSN).eq('volneid', membership[0].team.event_id).limit(1);
        if (volCheck && volCheck.length > 0) {
            return res.status(403).json({ error: 'You are volunteering for this event and cannot join as a team participant' });
        }
        const { data: otherTeams } = await supabaseAdmin
            .from('team_members').select('team_id, team:team_id(event_id)').eq('student_usn', userUSN).eq('join_status', true);
        if (otherTeams && otherTeams.length > 0) {
            const conflictTeam = otherTeams.find(t => t.team?.event_id === membership[0].team.event_id);
            if (conflictTeam) return res.status(400).json({ error: 'You have already joined another team for this event' });
        }
        await supabaseAdmin.from('team_members').update({ join_status: true }).eq('team_id', teamId).eq('student_usn', userUSN);
        console.log(`✅ User ${userUSN} successfully joined team ${teamId}`);
        res.json({ success: true, message: `Successfully joined team "${membership[0].team.team_name}"!`, teamId });
    } catch (err) {
        console.error('Error confirming join:', err);
        res.status(500).json({ error: 'Error confirming join' });
    }
});

// ==================== EXCEL GENERATION ====================

app.get('/api/events/:eventId/generate-details', requireAuth, async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userUSN = req.session.userUSN;

        const { data: event, error: eventError } = await supabaseAdmin
            .from('event')
            .select('eid, ename, eventdate, eventtime, eventloc, orgusn, max_activity_pts, vol_activity_pts')
            .eq('eid', eventId).limit(1);
        if (eventError || !event?.[0]) return res.status(404).json({ error: 'Event not found' });
        if (event[0].orgusn !== userUSN) return res.status(403).json({ error: 'Not authorized' });

        const eventData = event[0];

        const { data: organiser } = await supabaseAdmin
            .from('student').select('sname, usn').eq('usn', eventData.orgusn).maybeSingle();
        const organiserName = organiser?.sname || 'N/A';

        const { data: participants, error: participantError } = await supabaseAdmin
            .from('participant').select('partusn, partstatus, payment_status, team_id').eq('parteid', eventId);
        if (participantError) return res.status(500).json({ error: 'Database error (participants)' });

        const partUsns = participants && participants.length > 0 ? [...new Set(participants.map(p => p.partusn))] : [];
        const { data: students } = partUsns.length > 0
            ? await supabaseAdmin.from('student').select('usn, sname, sem, mobno, emailid').in('usn', partUsns)
            : { data: [] };
        const studentMap = (students || []).reduce((acc, s) => ({ ...acc, [s.usn]: s }), {});

        const { data: teams } = await supabaseAdmin.from('team').select('id, team_name').eq('event_id', eventId);
        const teamMap = (teams || []).reduce((acc, t) => ({ ...acc, [t.id]: t.team_name }), {});

        const { data: payments } = await supabaseAdmin
            .from('payment').select('usn, upi_transaction_id, amount').eq('event_id', eventId);
        const paymentMap = (payments || []).reduce((acc, p) => ({ ...acc, [p.usn]: p }), {});

        const { data: volunteers, error: volunteerError } = await supabaseAdmin
            .from('volunteer').select('volnusn, volnstatus').eq('volneid', eventId);
        if (volunteerError) return res.status(500).json({ error: 'Database error (volunteers)' });

        const volUsns = volunteers && volunteers.length > 0 ? [...new Set(volunteers.map(v => v.volnusn))] : [];
        const { data: volStudents } = volUsns.length > 0
            ? await supabaseAdmin.from('student').select('usn, sname').in('usn', volUsns)
            : { data: [] };
        const volStudentMap = (volStudents || []).reduce((acc, s) => ({ ...acc, [s.usn]: s }), {});

        const workbook = new ExcelJS.Workbook();
        const ws = workbook.addWorksheet('Event Details');
        ws.columns = [
            { width: 15 }, { width: 25 }, { width: 10 }, { width: 15 }, { width: 30 },
            { width: 15 }, { width: 20 }, { width: 20 }, { width: 30 }, { width: 15 }, { width: 20 }
        ];

        const hdr = ws.addRow(['EVENT DETAILS']);
        hdr.font = { size: 16, bold: true };
        hdr.alignment = { horizontal: 'center' };
        ws.mergeCells('A1:J1');
        ws.addRow([]);
        ws.addRow(['Event Name:', eventData.ename || 'N/A']);
        ws.addRow(['Event Date:', eventData.eventdate || 'N/A']);
        ws.addRow(['Event Time:', eventData.eventtime || 'N/A']);
        ws.addRow(['Event Location:', eventData.eventloc || 'N/A']);
        ws.addRow(['Organiser USN:', eventData.orgusn || 'N/A']);
        ws.addRow(['Organiser Name:', organiserName]);
        for (let i = 3; i <= 8; i++) {
            ws.getRow(i).font = { bold: true };
            ws.getRow(i).getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
        }

        ws.addRow([]);
        const partHdr = ws.addRow(['PARTICIPANTS']);
        partHdr.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
        partHdr.alignment = { horizontal: 'center' };
        ws.mergeCells(`A${partHdr.number}:J${partHdr.number}`);
        partHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

        const partCols = ws.addRow([
            'USN', 'Name', 'Semester', 'Mobile No', 'Email',
            'Participation Status', 'Payment Status', 'Team Name',
            'UPI Transaction ID', 'Payment Amount', 'Activity Points Earned'
        ]);
        partCols.font = { bold: true };
        partCols.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

        const maxActivityPts = eventData.max_activity_pts || 0;

        const { data: attendanceRaw } = await supabaseAdmin
            .from('sub_event_attendance').select('usn, seid').eq('eid', eventId).eq('role', 'participant');
        const { data: subEventPts } = await supabaseAdmin
            .from('sub_event').select('seid, activity_pts').eq('eid', eventId);
        const seidToPts = (subEventPts || []).reduce((acc, se) => ({ ...acc, [se.seid]: se.activity_pts || 0 }), {});
        const usnToPtsMap = {};
        (attendanceRaw || []).forEach(row => {
            if (!usnToPtsMap[row.usn]) usnToPtsMap[row.usn] = 0;
            usnToPtsMap[row.usn] += seidToPts[row.seid] || 0;
        });

        (participants || []).forEach(p => {
            const student = studentMap[p.partusn] || {};
            const payment = paymentMap[p.partusn] || {};
            const teamName = teamMap[p.team_id] || 'N/A';
            const earnedPts = p.partstatus ? Math.min(usnToPtsMap[p.partusn] || 0, maxActivityPts) : 0;
            ws.addRow([
                p.partusn || 'N/A', student.sname || 'N/A', student.sem || 'N/A',
                student.mobno || 'N/A', student.emailid || 'N/A',
                p.partstatus ? 'Present' : 'Absent', p.payment_status || 'N/A',
                teamName, payment.upi_transaction_id || 'N/A',
                payment.amount ?? (p.payment_status === 'free' ? '0' : 'N/A'), earnedPts
            ]);
        });

        ws.addRow([]);
        const volHdr = ws.addRow(['VOLUNTEERS']);
        volHdr.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
        volHdr.alignment = { horizontal: 'center' };
        ws.mergeCells(`A${volHdr.number}:D${volHdr.number}`);
        volHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } };

        const volCols = ws.addRow(['USN', 'Name', 'Volunteer Status', 'Activity Points Earned']);
        volCols.font = { bold: true };
        volCols.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };

        const volActivityPts = eventData.vol_activity_pts || 0;
        (volunteers || []).forEach(v => {
            const student = volStudentMap[v.volnusn] || {};
            ws.addRow([
                v.volnusn || 'N/A', student.sname || 'N/A',
                v.volnstatus ? 'Present' : 'Absent', v.volnstatus ? volActivityPts : 0
            ]);
        });

        ws.eachRow(row => {
            row.eachCell(cell => {
                cell.border = {
                    top: { style: 'thin' }, left: { style: 'thin' },
                    bottom: { style: 'thin' }, right: { style: 'thin' }
                };
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Event_${(eventData.ename || 'Event').replace(/\s+/g, '_')}_Details.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
        console.log(`✅ Excel generated for event ${eventId} by ${userUSN}`);
    } catch (err) {
        console.error('Excel generation error:', err);
        res.status(500).json({ error: 'Error generating Excel file' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📡 CORS enabled for: ${allowedOrigins.join(', ')}`);
    console.log(`🔐 Auth: Supabase Auth`);
    console.log(`🌱 Environment: ${IS_PRODUCTION ? 'production' : 'development'}\n`);
});
