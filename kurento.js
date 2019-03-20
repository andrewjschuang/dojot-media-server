"use strict";

var uuid = require('uuid');
var kurento = require('kurento-client');
var config = require('./config');

class SessionNotFound extends Error {
    constructor(...args) {
        super(...args);
        Error.captureStackTrace(this, SessionNotFound);
    }
}

class InternalError extends Error {
    constructor(...args) {
        super(...args);
        Error.captureStackTrace(this, InternalError);
    }
}

//TODO: Add status info to the sessions
class KurentoProxy {
    constructor() {
        this.kurentoClient = null;
        this.sessions = new Map();
    }

    createWebRTCSession(tenant, deviceId, device) {
        //The current implementation supports only one
        //session for each device (camera), but the final solution
        //should support multile sessions
        let key = `${tenant}:${deviceId}`;
        if (this.sessions.has(key)) {
            try {
                console.warn(`Deleting existing session for device ${tenant}:${deviceId}`);
                this.sessions.get(key).flow.pipeline.release();
                this.sessions.delete(`${tenant}:${deviceId}`);
            }
            catch (error) {
                return Promise.reject(
                    new InternalError(
                        `The existing session for device ${tenant}:${deviceId} couldn\'t be deleted.`));
            }
        }

        return this._createKurentoRTSPToWebRTCFlow(device.url).then(rtspToWebRtcflow => {
            let session = {
                id: uuid.v4(),
                flow: rtspToWebRtcflow
            }
            this.sessions.set(key, session);
            return Promise.resolve(session.id);
        }).catch(error => {
            console.debug(error);
            return Promise.reject(
                new InternalError(
                    `Failed to configure RSTP to WebRTC flow for device ${tenant}:${deviceId}.`));
        });
    }

    //TODO check session status
    addRemoteIceCandidates(tenant, deviceId, sessionId, iceCandidateList) {
        return new Promise((resolve, reject) => {
            let key = `${tenant}:${deviceId}`;
            if (!this.sessions.has(key) ||
                this.sessions.get(key).id !== sessionId) {
                reject(new SessionNotFound(`Session ${sessionId} doesn\'t exist.`));
            }

            for (let _candidate of iceCandidateList) {
                let candidate = kurento.getComplexType('IceCandidate')(_candidate.candidate);
                this.sessions.get(key).flow.webRtcEndpoint.addIceCandidate(candidate, function (error) {
                    reject(new InternalError(`Failed to add ice candidate ${_candidate.candidate}`));
                });
                console.debug(`Added ice candidate ${JSON.stringify(_candidate.candidate)}`);
            }
            resolve();
        });
    }

    //TODO check session status
    getLocalIceCandidates(tenant, deviceId, sessionId) {
        let key = `${tenant}:${deviceId}`;
        if (!this.sessions.has(key) ||
            this.sessions.get(key).id !== sessionId) {
            throw new SessionNotFound(`Session ${sessionId} doesn't exist.`);
        }
        console.debug(JSON.stringify(this.sessions.get(key).flow));
        return this.sessions.get(key).flow.iceCandidates;
    }

    //TODO check session status
    startWebRTCSession(tenant, deviceId, sessionId, sdpOffer) {
        return new Promise((resolve, reject) => {
            let key = `${tenant}:${deviceId}`;
            if (!this.sessions.has(key) ||
                this.sessions.get(key).id !== sessionId) {
                reject(new SessionNotFound(`Session ${sessionId} doesn't exist.`));
            }

            console.debug(`Processing SDP offer for session ${sessionId} ...`);
            this.sessions.get(key).flow.webRtcEndpoint.processOffer(sdpOffer, (error, answer) => {
                if (error) {
                    this.sessions.get(key).flow.pipeline.release();
                    reject(new InternalError('Failed to process SDP offer.'));
                }
                console.debug(`Processed SDP offer (answer = ${JSON.stringify(answer)})!`);

                this.sessions.get(key).flow.rtspEndpoint.play(error => {
                    if (error) {
                        this.sessions.get(key).flow.pipeline.release();
                        reject(new InternalError('Failed to play video.'));
                    }
                    console.debug('Playing video ...');
                });

                console.debug(`Gathering candidates for session ${sessionId} ...`);
                this.sessions.get(key).flow.webRtcEndpoint.gatherCandidates(error => {
                    if (error) {
                        console.log(error);
                        this.sessions.get(key).flow.pipeline.release();
                        reject(new InternalError('Failed to gather candidates'));
                    }
                });

                resolve(answer);
            });
        });
    }

    readWebRTCSession(tenant, deviceId, sessionId) {
        console.debug('Reading Session ...');
        let key = `${tenant}:${deviceId}`;
        if (this.sessions.has(key) &&
            this.sessions.get(key).id === sessionId) {
            return this.sessions[`${tenant}:${deviceId}`];
        }
        throw new SessionNotFound(`Session ${sessionId} doesn't exist.`);
    }

    deleteWebRTCSession(tenant, deviceId, sessionId) {
        console.debug('Deleting Session ...');
        let key = `${tenant}:${deviceId}`;
        if (this.sessions.has(key) &&
            this.sessions.get(key).id === sessionId) {
            this.sessions.get(key).flow.pipeline.release();
            return this.sessions.delete(`${tenant}:${deviceId}`);
        }
        throw new SessionNotFound(`Session ${sessionId} doesn't exist.`);
    }

    // get kurento client
    _getKurentoClient(callback) {
        console.debug(`Getting Kurento Client at ${config.kurento.ws_uri}`);

        if (this.kurentoClient !== null) {
            console.debug('Kurento Client already created');
            return callback();
        }

        kurento(config.kurento.ws_uri, (error, client) => {
            console.debug("Trying to connect to KMS at address " + config.kurento.ws_uri);
            if (error) {
                console.error("Could not connect to KMS.");
                return callback("Failed to connect to Kurento Media Server.");
            }

            console.info("Connected to KMS at address " + config.kurento.ws_uri);
            this.kurentoClient = client;
            return callback();
        });
    }

    // create rtstp to webrtc flow
    _createKurentoRTSPToWebRTCFlow(url) {
        console.debug(`Creating pipeline for RTSP ${url} to WebRTC ...`);

        return new Promise((resolve, reject) => {
            this._getKurentoClient(error => {
                if (error) {
                    console.error('Failed to get Kurento Client!');
                    console.error(error);
                    return reject();
                }

                let flow = {};

                this.kurentoClient.create('MediaPipeline', (error, _pipeline) => {
                    if (error) {
                        console.error('Failed to create pipeline!');
                        return reject();
                    }

                    console.debug('Created pipeline!');
                    flow.pipeline = _pipeline;

                    let promises = [
                        this._createMediaElements(flow.pipeline, 'PlayerEndpoint', { uri: url }),
                        this._createMediaElements(flow.pipeline, 'WebRtcEndpoint', {}),
                        this._createMediaElements(flow.pipeline, 'Composite', {}),
                    ]

                    Promise.all(promises).then(result => {
                        var playerEndpoint = result[0];
                        var webRtcEndpoint = result[1];
                        var composite = result[2];

                        console.debug('Created Media Elements!');
                        flow.rtspEndpoint = playerEndpoint;
                        flow.webRtcEndpoint = webRtcEndpoint;

                        let promises = [
                            this._createHubPort(composite),
                            this._createHubPort(composite),
                        ]

                        Promise.all(promises).then(result => {
                            var hubPortOut = result[0];
                            var hubPortIn1 = result[1];

                            console.debug('Created HubPorts!');

                            console.debug('Registering callback for handling onIceCandidate events ...');
                            flow.iceCandidates = [];
                            var _handleLocalIceCandidate = function (event) {
                                let _candidate = kurento.getComplexType('IceCandidate')(event.candidate);
                                this.iceCandidates.push({ candidate: _candidate });
                                console.debug(`Added local ice candidate ${JSON.stringify(_candidate)}`);
                            }
                            var _handleSessionLocalIceCandidate = _handleLocalIceCandidate.bind(flow);
                            flow.webRtcEndpoint.on('OnIceCandidate', _handleSessionLocalIceCandidate);

                            let promises = [
                                this._connectMediaElements(flow.rtspEndpoint, hubPortIn1),
                                this._connectMediaElements(hubPortOut, flow.webRtcEndpoint),
                            ]

                            Promise.all(promises).then(result => {
                                console.debug('Connected Media Elements!');
                                console.log(flow);

                                return resolve(flow);
                            }).catch(error => {
                                console.error('Failed to connect Media Elements!');
                                flow.pipeline.release();
                                return reject();
                            });
                        }).catch(() => {
                            console.error('Failed to create HubPorts!');
                            flow.pipeline.release();
                            return reject();
                        });
                    }).catch(() => {
                        console.error('Failed to create Media Elements!');
                        flow.pipeline.release();
                        return reject();
                    });
                });
            });
        });
    }

    _createMediaElements(pipeline, type, options) {
        return new Promise((resolve, reject) => {
            pipeline.create(type, options, (error, result) => {
                if (error) {
                    return reject(error);
                }

                return resolve(result);
            })
        });
    }

    _connectMediaElements(sourceElement, sinkElement) {
        return new Promise((resolve, reject) => {
            sourceElement.connect(sinkElement, error => {
                if (error) {
                    return reject(error);
                }

                return resolve();
            });
        });
    }

    _createHubPort(composite) {
        return new Promise((resolve, reject) => {
            composite.createHubPort((error, hubPort) => {
                if (error) {
                    return reject(error);
                }

                return resolve(hubPort);
            });
        });
    }

    _setOverlayedImage(faceOverlayFilter, img, coordinates) {
        return new Promise((resolve, reject) => {
            faceOverlayFilter.setOverlayedImage(img, coordinates[0], coordinates[1], coordinates[2], coordinates[3], (error) => {
                if (error) {
                    return reject(error);
                }

                return resolve(faceOverlayFilter);
            });
        });
    }

    _webRtcExec(sessionId, pipeline, webRtcEndpoint, ws, sdpOffer, callback) {
        if (candidatesQueue[sessionId]) {
            while (candidatesQueue[sessionId].length) {
                var candidate = candidatesQueue[sessionId].shift();
                webRtcEndpoint.addIceCandidate(candidate);
            }
        }

        webRtcEndpoint.on('OnIceCandidate', event => {
            var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
            ws.send(JSON.stringify({
                id: 'iceCandidate',
                candidate: candidate
            }));
        });

        webRtcEndpoint.processOffer(sdpOffer, (error, sdpAnswer) => {
            if (error) {
                pipeline.release();
                return callback(error);
            }

            sessions[sessionId] = {
                'pipeline': pipeline,
                'webRtcEndpoint': webRtcEndpoint
            }

            return callback(null, sdpAnswer);
        });

        webRtcEndpoint.gatherCandidates(error => {
            if (error) {
                return callback(error);
            }
        });
    }
}

module.exports = {
    SessionNotFound: SessionNotFound,
    InternalError: InternalError,
    KurentoProxy: KurentoProxy
};
