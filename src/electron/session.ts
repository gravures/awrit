import { app, session as ElectronSession, type Session } from 'electron';

export const sessionPromise = new Promise<Session>((resolve) => {
  app.whenReady().then(() => {
    const session = ElectronSession.fromPartition('persist:custom-awrit');
    // pretend we're Chrome
    const userAgent = session
      .getUserAgent()
      .replace(/\sElectron\/\S+/, '')
      .replace(new RegExp(`\\s${app.getName()}/\\S+`), '');

    session.setUserAgent(userAgent);
    resolve(session);
  });
});
