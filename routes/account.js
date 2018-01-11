'use strict';

const config = require('wild-config');
const crypto = require('crypto');
const express = require('express');
const router = new express.Router();
const passport = require('../lib/passport');
const tools = require('../lib/tools');
const Joi = require('joi');
const apiClient = require('../lib/api-client');
const roleBasedAddresses = require('role-based-email-addresses');
const util = require('util');
const humanize = require('humanize');
const addressparser = require('addressparser');

const AUTH_EVENTS = new Map([
    ['create asp', 'Create new Application Specific Password'],
    ['delete asp', 'Deleted Application Specific Password'],
    ['account created', 'Account was created'],
    ['enable 2fa totp', 'Enable 2FA mobile authenticator'],
    ['disable 2fa totp', 'Disable 2FA mobile authenticator'],
    ['check 2fa totp', 'Authenticating with mobile authenticator'],
    ['enable 2fa u2f', 'Enable 2FA security key'],
    ['disable 2fa u2f', 'Disable 2FA security key'],
    ['check 2fa u2f', 'Authenticating with security key'],
    ['disable 2fa', 'Disable 2FA on account'],
    ['password change', 'Changing account password'],
    ['authentication', 'Authenticating with password']
]);

// sub services
router.use('/filters', passport.checkLogin, require('./account/filters'));
router.use('/autoreply', passport.checkLogin, require('./account/autoreply'));

router.get('/', passport.csrf, passport.checkLogin, (req, res, next) => {
    apiClient.users.get(req.user.id, (err, userData) => {
        if (err) {
            return next(err);
        }

        res.render('account/index', {
            activeHome: true,

            address: userData.address,

            quota: humanize.filesize(userData.limits.quota.allowed),
            storageUsed: humanize.filesize(userData.limits.quota.used),
            storageOverview: Math.round(userData.limits.quota.used / userData.limits.quota.allowed * 100),

            recipients: humanize.numberFormat(userData.limits.recipients.allowed, 0),
            recipientsSent: humanize.numberFormat(userData.limits.recipients.used, 0),
            recipientsOverview: Math.round(userData.limits.recipients.used / (userData.limits.recipients.allowed || 1) * 100),

            forwards: humanize.numberFormat(userData.limits.forwards.allowed, 0),
            forwardsSent: humanize.numberFormat(userData.limits.forwards.used, 0),
            forwardsOverview: Math.round(userData.limits.forwards.used / (userData.limits.forwards.allowed || 1) * 100)
        });
    });
});

router.get('/security/logins', (req, res, next) => {
    const updateSchema = Joi.object().keys({
        next: Joi.string()
            .max(100)
            .empty(''),
        previous: Joi.string()
            .max(100)
            .empty(''),
        page: Joi.number().empty('')
    });

    let result = Joi.validate(req.query, updateSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/account/security/logins');
    }

    apiClient.asps.list(req.user.id, (err, asps) => {
        if (err) {
            return next(err);
        }

        let aspsmap = new Map();
        asps.forEach(asp => {
            aspsmap.set(asp.id, asp);
        });

        apiClient.authlog.list(req.user.id, { next: req.query.next, previous: req.query.previous, page: result.value.page || 1 }, (err, log) => {
            if (err) {
                return next(err);
            }
            log.nextPage = log.page + 1;
            log.previousPage = Math.max(log.page - 1, 1);
            log.results.forEach(entry => {
                if (entry.asp) {
                    entry.asp = {
                        id: entry.asp,
                        name: entry.aname
                    };
                }
                if (!entry.protocol || entry.protocol === 'API') {
                    entry.protocol = 'Web';
                }
                entry.action = AUTH_EVENTS.get(entry.action) || entry.action;
                switch (entry.result) {
                    case 'success':
                        entry.label = 'success';
                        entry.result = 'Success';
                        break;
                    case 'fail':
                        entry.label = 'danger';
                        entry.result = 'Failed';
                        break;
                }
            });
            res.render('account/security/logins', log);
        });
    });
});

router.get('/logout', (req, res) => {
    req.session.require2fa = false;
    req.flash(); // clear pending messages
    passport.logout(req, res);
});

router.post('/login', passport.parse, (req, res, next) => passport.login(req, res, next));

router.get('/login', (req, res) => {
    res.render('account/login', {
        activeLogin: true
    });
});

router.get('/create', passport.csrf, (req, res, next) => {
    if (!config.service.allowJoin) {
        let err = new Error('User registration is disabled');
        err.status = 404;
        return next(err);
    }
    res.render('account/create', {
        title: 'Create new account',
        activeCreate: true,
        csrfToken: req.csrfToken()
    });
});

router.post('/create', passport.parse, passport.csrf, (req, res, next) => {
    if (!config.service.allowJoin) {
        let err = new Error('User registration is disabled');
        err.status = 404;
        return next(err);
    }
    const createSchema = {
        name: Joi.string()
            .trim()
            .min(3)
            .max(100)
            .label('Your name')
            .required(),
        password: Joi.string()
            .min(8)
            .max(100)
            .label('Password')
            .valid(Joi.ref('password2'))
            .options({
                language: {
                    any: {
                        allowOnly: '!!Passwords do not match'
                    }
                }
            })
            .required(),

        language: Joi.string()
            .length(2)
            .default('en'),
        password2: Joi.string()
            .min(8)
            .max(100)
            .label('Password confirmation')
            .required(),
        username: Joi.string()
            .trim()
            .min(3)
            .max(128)
            .hostname()
            .lowercase()
            .label('Address')
            .required()
    };

    delete req.body._csrf;
    let result = Joi.validate(req.body, createSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false,
        language: {
            string: {
                min: '"{{!key}}" length must be at least {{limit}} characters long',
                max: '"{{!key}}" length must be less than or equal to {{limit}} characters',
                hostname: '"{{!key}}" must be a valid email user part'
            },
            object: {
                assert: '!!Passwords do not match'
            }
        }
    });

    let showErrors = (errors, disableDefault) => {
        if (!disableDefault) {
            req.flash('danger', 'Failed creating account');
        }
        res.render('account/create', {
            title: 'Create new account',
            values: result.value,
            errors,
            activeCreate: true,
            csrfToken: req.csrfToken()
        });
    };

    if (result.error) {
        let errors = {};

        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                if (!errors[detail.path]) {
                    errors[detail.path] = detail.message;
                }
            });
        }

        return showErrors(errors);
    }

    if (
        ['abuse', 'admin', 'administrator', 'hostmaster', 'majordomo', 'postmaster', 'root', 'ssl-admin', 'webmaster'].includes(result.value.username) ||
        roleBasedAddresses.includes(result.value.username)
    ) {
        return showErrors({
            username: util.format('"%s" is a reserved username', result.value.username)
        });
    }

    apiClient.users.create(
        {
            name: result.value.name,
            username: result.value.username,
            password: result.value.password,
            address: result.value.username + '@' + config.service.domain,
            recipients: 500,
            forwards: 500,
            quota: 1 * 1024 * 1024 * 1024,
            ip: req.ip
        },
        err => {
            if (err) {
                if (err.fields) {
                    return showErrors(err.fields);
                } else {
                    req.flash('danger', err.message);
                    return showErrors({}, true);
                }
            }

            req.flash('success', 'Account created for ' + result.value.username + ' with address ' + result.value.username + '@' + config.service.domain);
            res.redirect('/account/login/');
        }
    );
});

router.get('/security', passport.csrf, passport.checkLogin, (req, res, next) => {
    apiClient.users.get(req.user.id, (err, userData) => {
        if (err) {
            return next(err);
        }
        apiClient.asps.list(req.user.id, (err, asps) => {
            if (err) {
                return next(err);
            }
            res.render('account/security', {
                title: 'Security',
                activeSecurity: true,
                values: req.user,

                csrfToken: req.csrfToken(),

                enabled2fa: userData.enabled2fa,
                enabledTotp: userData.enabled2fa ? userData.enabled2fa.includes('totp') : false,
                enabledU2f: userData.enabled2fa ? userData.enabled2fa.includes('u2f') : false,

                asps: asps.reverse().map((entry, i) => {
                    entry.index = i + 1;

                    entry.scope = entry.scopes.includes('*') ? 'All' : entry.scopes.join(', ');
                    return entry;
                })
            });
        });
    });
});

router.get('/profile', passport.csrf, passport.checkLogin, (req, res, next) => {
    apiClient.users.get(req.user.id, (err, userData) => {
        if (err) {
            return next(err);
        }

        userData.forward = [].concat(userData.forward).join(', ');

        res.render('account/profile', {
            title: 'Account',
            activeProfile: true,
            values: userData,
            csrfToken: req.csrfToken()
        });
    });
});

router.post('/profile', passport.parse, passport.csrf, passport.checkLogin, (req, res) => {
    const updateSchema = Joi.object()
        .keys({
            name: Joi.string()
                .empty('')
                .max(100)
                .label('Your name'),

            forward: Joi.string()
                .empty('')
                .label('Forward address'),
            targetUrl: Joi.string()
                .trim()
                .uri({
                    scheme: ['http', 'https'],
                    allowRelative: false,
                    relativeOnly: false
                })
                .empty('')
                .label('Upload URL'),

            pubKey: Joi.string()
                .empty('')
                .trim()
                .regex(/^-----BEGIN PGP PUBLIC KEY BLOCK-----/, 'PGP key format'),
            encryptMessages: Joi.boolean()
                .truthy(['Y', 'true', 'yes', 'on', 1])
                .falsy(['N', 'false', 'no', 'off', 0, ''])
                .default(false),

            existingPassword: Joi.string()
                .empty('')
                .min(8)
                .max(100)
                .label('Current password'),
            password: Joi.string()
                .empty('')
                .min(8)
                .max(100)
                .label('New password')
                .valid(Joi.ref('password2'))
                .options({
                    language: {
                        any: {
                            allowOnly: '!!Passwords do not match'
                        }
                    }
                }),
            password2: Joi.string()
                .empty('')
                .min(8)
                .max(100)
                .label('Repeat password')
        })
        .and('password', 'existingPassword', 'password2');

    delete req.body._csrf;
    let result = Joi.validate(req.body, updateSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false,

        language: {
            string: {
                min: '"{{!key}}" length must be at least {{limit}} characters long',
                max: '"{{!key}}" length must be less than or equal to {{limit}} characters',
                hostname: '"{{!key}}" must be a valid email user part'
            },
            object: {
                assert: '!!Passwords do not match'
            }
        }
    });

    let showErrors = (errors, disableDefault) => {
        if (!disableDefault) {
            req.flash('danger', 'Account update failed');
        }

        if (Array.isArray(result.value.forward)) {
            result.value.forward = result.value.forward.join(', ');
        }

        res.render('account/profile', {
            title: 'Account',
            activeProfile: true,
            values: result.value,
            errors,

            csrfToken: req.csrfToken()
        });
    };

    if (result.error) {
        let errors = {};
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                let path = detail.path;
                if (detail.path === 'value') {
                    path = 'existingPassword';
                }
                if (!errors[path]) {
                    errors[path] = detail.message;
                }
            });
        }

        return showErrors(errors);
    }

    delete result.value.password2;
    result.value.name = result.value.name || '';
    result.value.forward = addressparser(result.value.forward || '')
        .map(addr => tools.normalizeAddress(addr.address))
        .filter(fwd => fwd);

    result.value.targetUrl = result.value.targetUrl || '';
    result.value.pubKey = result.value.pubKey || '';

    result.value.ip = req.ip;

    apiClient.users.update(req.user.id, result.value, err => {
        if (err) {
            if (err.fields) {
                return showErrors(err.fields);
            } else {
                req.flash('danger', err.message);
                return showErrors({}, true);
            }
        }

        req.flash('success', 'Updated account data for ' + req.user.username);
        res.redirect('/account/profile/');
    });
});

router.post('/asp/delete', passport.parse, passport.csrf, passport.checkLogin, (req, res) => {
    const updateSchema = Joi.object().keys({
        id: Joi.string()
            .trim()
            .hex()
            .length(24)
            .label('Password ID')
            .required()
    });

    delete req.body._csrf;
    let result = Joi.validate(req.body, updateSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/account/security');
    }

    apiClient.asps.del(req.user.id, result.value.id, req.ip, err => {
        if (err) {
            req.flash('danger', 'Database Error, failed to delete data');
            return res.redirect('/account/security');
        }

        req.flash('success', 'Application specific password was deleted');
        return res.redirect('/account/security');
    });
});

router.post('/asp/create', passport.parse, passport.csrf, passport.checkLogin, (req, res) => {
    const updateSchema = Joi.object().keys({
        description: Joi.string()
            .trim()
            .min(0)
            .max(256)
            .label('Description')
            .required()
    });

    delete req.body._csrf;
    let result = Joi.validate(req.body, updateSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false
    });

    if (result.error) {
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                req.flash('danger', detail.message);
            });
        }
        return res.redirect('/account/security');
    }

    let data = {
        description: result.value.description,
        scopes: '*',
        generateMobileconfig: true,
        ip: req.ip
    };

    apiClient.asps.create(req.user.id, data, (err, response) => {
        if (err) {
            req.flash('danger', err.message);
            return res.redirect('/account/security');
        }

        res.render('account/asp', {
            layout: 'layout-popup',
            description: result.value.description,
            password: response.password,
            mobileconfig: response.mobileconfig,
            csrfToken: req.csrfToken(),
            passwordFormatted: response.password.replace(/.{4}/g, '$& ').trim()
        });
    });
});

router.post('/enable-2fa', passport.parse, passport.csrf, passport.checkLogin, (req, res, next) => {
    const authSchema = Joi.object().keys({
        token: Joi.string()
            .length(6)
            .regex(/^[0-9]+$/, 'numbers')
    });

    delete req.body._csrf;
    let result = Joi.validate(req.body, authSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false
    });

    let showErrors = errors => {
        apiClient['2fa'].setupTotp(req.user.id, config.totp.issuer || config.name, false, req.ip, (err, data) => {
            if (err) {
                return next(err);
            }
            res.render('account/enable-2fa', {
                layout: 'layout-popup',
                title: 'Two factor authentication',
                activeSecurity: true,
                csrfToken: req.csrfToken(),
                imageUrl: data.qrcode,
                activeLogin: true,
                errors
            });
        });
    };

    if (result.error) {
        let errors = {};
        if (result.error && result.error.details) {
            result.error.details.forEach(detail => {
                let path = detail.path;
                if (!errors[path]) {
                    errors[path] = detail.message;
                }
            });
        }

        return showErrors(errors);
    }

    apiClient['2fa'].setupTotp(req.user.id, config.totp.issuer || config.name, true, req.ip, (err, data) => {
        if (err) {
            return next(err);
        }
        res.render('account/enable-2fa', {
            layout: 'layout-popup',
            title: 'Two factor authentication',
            activeSecurity: true,
            csrfToken: req.csrfToken(),
            imageUrl: data.qrcode
        });
    });
});

router.post('/verify-totp', passport.parse, passport.csrf, (req, res) => {
    const authSchema = Joi.object().keys({
        token: Joi.string()
            .length(6)
            .regex(/^[0-9]+$/, 'numbers')
            .required()
    });

    delete req.body._csrf;
    let result = Joi.validate(req.body, authSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false
    });

    if (result.error) {
        return res.json({ error: result.error.message });
    }

    apiClient['2fa'].verifyTotp(req.user.id, result.value.token, req.ip, err => {
        if (err) {
            return res.json({ error: err.message, code: err.code });
        }

        req.flash('success', 'Two factor authentication is now enabled');
        res.json({
            success: true,
            targetUrl: '/account/security'
        });
    });
});

router.post('/disable-2fa', passport.parse, passport.csrf, passport.checkLogin, (req, res, next) => {
    apiClient['2fa'].disable(req.user.id, req.ip, err => {
        if (err) {
            return next(err);
        }
        req.session.require2fa = false;
        req.flash('success', 'Two factor authentication is now disabled');
        res.redirect('/account/security');
    });
});

router.post('/check-totp', passport.parse, passport.csrf, (req, res) => {
    const authSchema = Joi.object().keys({
        token: Joi.string()
            .length(6)
            .regex(/^[0-9]+$/, 'numbers')
            .required(),
        remember2fa: Joi.boolean()
            .truthy(['Y', 'true', 'yes', 'on', 1])
            .falsy(['N', 'false', 'no', 'off', 0, ''])
            .default(false)
    });

    delete req.body._csrf;
    let result = Joi.validate(req.body, authSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false
    });

    if (result.error) {
        return res.json({ error: result.error.message });
    }

    let remember2fa = result.value.remember2fa;
    apiClient['2fa'].checkTotp(req.user.id, result.value.token, req.ip, (err, result) => {
        if (err) {
            return res.json({ error: err.message, code: err.code });
        }

        if (!result) {
            return res.json({ error: 'Could not verify token' });
        }

        let data = {
            success: true,
            targetUrl: '/account/'
        };

        if (remember2fa) {
            data.remember2fa = {
                username: req.session.username,
                value: generate2faRemeberToken(req.user.id)
            };
        }

        req.session.require2fa = false;
        res.json(data);
    });
});

router.post('/start-u2f', passport.parse, passport.csrf, (req, res) => {
    if (!config.u2f.enabled) {
        let err = new Error('U2F support is disabled');
        return res.json({ error: err.message });
    }

    apiClient['2fa'].startU2f(req.user.id, req.ip, (err, data) => {
        if (err) {
            return res.json({ error: err.message });
        }
        res.json(data);
    });
});

router.post('/check-u2f', passport.parse, passport.csrf, (req, res) => {
    if (!config.u2f.enabled) {
        let err = new Error('U2F support is disabled');
        return res.json({ error: err.message });
    }

    const authSchema = Joi.object().keys({
        keyHandle: Joi.string(),
        clientData: Joi.string(),
        signatureData: Joi.string(),
        errorCode: Joi.number(),
        errorMessage: Joi.string(),
        remember2fa: Joi.boolean()
            .truthy(['Y', 'true', 'yes', 'on', 1])
            .falsy(['N', 'false', 'no', 'off', 0, ''])
            .default(false)
    });

    delete req.body._csrf;
    let result = Joi.validate(req.body, authSchema, {
        abortEarly: false,
        convert: true,
        allowUnknown: false
    });

    if (result.error) {
        return res.json({ error: result.error.message });
    }

    let requestData = { ip: req.ip };
    Object.keys(result.value || {}).forEach(key => {
        if (['signatureData', 'clientData', 'errorCode'].includes(key)) {
            requestData[key] = req.body[key];
        }
    });

    let remember2fa = result.value.remember2fa;

    apiClient['2fa'].checkU2f(req.user.id, requestData, (err, data) => {
        if (err) {
            return res.json({ error: err.message });
        }

        if (!data || !data.success) {
            return res.json({ error: 'Could not verify key' });
        }

        if (remember2fa) {
            data.remember2fa = {
                username: req.session.username,
                value: generate2faRemeberToken(req.user.id)
            };
        }

        req.session.require2fa = false;
        data.targetUrl = '/account/';
        res.json(data);
    });
});

router.post('/enable-u2f', passport.parse, passport.csrf, passport.checkLogin, (req, res, next) => {
    if (!config.u2f.enabled) {
        let err = new Error('U2F support is disabled');
        err.status = 404;
        return next(err);
    }

    res.render('account/enable-u2f', {
        layout: 'layout-popup',
        title: 'Two factor authentication',
        activeSecurity: true,
        csrfToken: req.csrfToken()
    });
});

router.post('/setup-u2f', passport.parse, passport.csrf, (req, res) => {
    if (!config.u2f.enabled) {
        let err = new Error('U2F support is disabled');
        return res.json({ error: err.message });
    }

    apiClient['2fa'].setupU2f(req.user.id, req.ip, (err, data) => {
        if (err) {
            return res.json({ error: err.message });
        }
        req.flash('success', 'U2F key was added to your account');
        res.json(data);
    });
});

router.post('/disable-u2f', passport.parse, passport.csrf, passport.checkLogin, (req, res, next) => {
    if (!config.u2f.enabled) {
        let err = new Error('U2F support is disabled');
        err.status = 404;
        return next(err);
    }

    apiClient['2fa'].disableU2f(req.user.id, req.ip, (err, data) => {
        if (err) {
            return next(err);
        }
        if (!data.success) {
            return next(new Error('Did not receive U2F data'));
        }
        req.flash('success', 'U2F was disabled');
        res.redirect('/account/security/');
    });
});

router.post('/enable-u2f/verify', passport.parse, passport.csrf, passport.checkLogin, (req, res) => {
    if (!config.u2f.enabled) {
        let err = new Error('U2F support is disabled');
        return res.json({ error: err.message });
    }

    let requestData = { ip: req.ip };
    Object.keys(req.body || {}).forEach(key => {
        if (['registrationData', 'clientData', 'errorCode'].includes(key)) {
            requestData[key] = req.body[key];
        }
    });
    apiClient['2fa'].enableU2f(req.user.id, requestData, (err, data) => {
        if (err) {
            return res.json({ error: err.message });
        }
        data.targetUrl = '/account/security';
        res.json(data);
    });
});

function generate2faRemeberToken(user) {
    let parts = [Date.now().toString(16), crypto.randomBytes(6).toString('hex')];

    let valueStr = parts.join('::');
    let hash = crypto
        .createHmac('sha256', config.totp.secret + ':' + user)
        .update(valueStr)
        .digest('hex');

    return valueStr + '::' + hash;
}

module.exports = router;
