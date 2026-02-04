/*
 * Purpose: Minimal WebAuthn helpers for passkey registration and login.
 */
(function () {
    function bufferToBase64URLString(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        bytes.forEach((byte) => {
            binary += String.fromCharCode(byte);
        });
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function base64URLStringToBuffer(base64URLString) {
        let base64 = base64URLString.replace(/-/g, '+').replace(/_/g, '/');
        const padding = base64.length % 4;
        if (padding) {
            base64 += '='.repeat(4 - padding);
        }
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function prepareRegistrationOptions(options) {
        return {
            ...options,
            challenge: base64URLStringToBuffer(options.challenge),
            user: {
                ...options.user,
                id: base64URLStringToBuffer(options.user.id)
            },
            excludeCredentials: (options.excludeCredentials || []).map((cred) => ({
                ...cred,
                id: base64URLStringToBuffer(cred.id)
            }))
        };
    }

    function prepareAuthenticationOptions(options) {
        return {
            ...options,
            challenge: base64URLStringToBuffer(options.challenge),
            allowCredentials: (options.allowCredentials || []).map((cred) => ({
                ...cred,
                id: base64URLStringToBuffer(cred.id)
            }))
        };
    }

    function credentialToJSON(cred) {
        if (!cred) {
            return null;
        }
        const response = {};
        if (cred.response) {
            if (cred.response.clientDataJSON) {
                response.clientDataJSON = bufferToBase64URLString(cred.response.clientDataJSON);
            }
            if (cred.response.attestationObject) {
                response.attestationObject = bufferToBase64URLString(cred.response.attestationObject);
            }
            if (cred.response.authenticatorData) {
                response.authenticatorData = bufferToBase64URLString(cred.response.authenticatorData);
            }
            if (cred.response.signature) {
                response.signature = bufferToBase64URLString(cred.response.signature);
            }
            if (cred.response.userHandle) {
                response.userHandle = bufferToBase64URLString(cred.response.userHandle);
            }
        }
        if (cred.response && typeof cred.response.getTransports === 'function') {
            response.transports = cred.response.getTransports();
        }

        const payload = {
            id: cred.id,
            rawId: bufferToBase64URLString(cred.rawId),
            type: cred.type,
            response,
            clientExtensionResults: cred.getClientExtensionResults()
        };
        return payload;
    }

    async function startPasskeyRegistration(token) {
        if (!window.PublicKeyCredential) {
            throw new Error('Passkeys not supported on this device.');
        }
        const optionsRes = await fetch('/webauthn/register-options', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({})
        });

        const rawOptionsText = await optionsRes.text();
        let optionsData = null;
        try {
            optionsData = JSON.parse(rawOptionsText);
        } catch (err) {
            optionsData = null;
        }
        if (!optionsRes.ok) {
            const message = optionsData && optionsData.message ? optionsData.message : (rawOptionsText || 'Failed to start passkey setup.');
            throw new Error(message);
        }
        if (!optionsData || !optionsData.options) {
            throw new Error('Invalid passkey setup response.');
        }

        const publicKey = prepareRegistrationOptions(optionsData.options);
        const credential = await navigator.credentials.create({ publicKey });
        if (!credential) {
            throw new Error('Passkey creation was cancelled.');
        }
        const verifyRes = await fetch('/webauthn/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({
                credential: credentialToJSON(credential),
                challenge: optionsData.options.challenge
            })
        });

        const rawVerifyText = await verifyRes.text();
        let verifyData = null;
        try {
            verifyData = JSON.parse(rawVerifyText);
        } catch (err) {
            verifyData = null;
        }
        if (!verifyRes.ok) {
            const message = verifyData && verifyData.message ? verifyData.message : (rawVerifyText || 'Passkey verification failed.');
            throw new Error(message);
        }
        return verifyData;
    }

    async function startPasskeyAuthentication() {
        if (!window.PublicKeyCredential) {
            throw new Error('Passkeys not supported on this device.');
        }
        const optionsRes = await fetch('/webauthn/auth-options', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        const rawOptionsText = await optionsRes.text();
        let optionsData = null;
        try {
            optionsData = JSON.parse(rawOptionsText);
        } catch (err) {
            optionsData = null;
        }
        if (!optionsRes.ok) {
            const message = optionsData && optionsData.message ? optionsData.message : (rawOptionsText || 'Failed to start passkey login.');
            throw new Error(message);
        }
        if (!optionsData || !optionsData.options) {
            throw new Error('Invalid passkey login response.');
        }

        const publicKey = prepareAuthenticationOptions(optionsData.options);
        const assertion = await navigator.credentials.get({ publicKey });
        if (!assertion) {
            throw new Error('Passkey login was cancelled.');
        }

        const verifyRes = await fetch('/webauthn/auth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                credential: credentialToJSON(assertion),
                challenge: optionsData.options.challenge
            })
        });

        const rawVerifyText = await verifyRes.text();
        let verifyData = null;
        try {
            verifyData = JSON.parse(rawVerifyText);
        } catch (err) {
            verifyData = null;
        }
        if (!verifyRes.ok) {
            const message = verifyData && verifyData.message ? verifyData.message : (rawVerifyText || 'Passkey login failed.');
            throw new Error(message);
        }

        return verifyData;
    }

    window.webauthn = {
        startPasskeyRegistration,
        startPasskeyAuthentication
    };
})();
