import { execFileSync } from 'node:child_process';
const artifact=process.argv[2],profile=process.env.XIPU_NOTARY_PROFILE;
if(!artifact||!profile)throw new Error('Usage: XIPU_NOTARY_PROFILE=<Keychain profile> node scripts/sign.mjs <signed .dmg>');
execFileSync('/usr/bin/xcrun',['notarytool','submit',artifact,'--keychain-profile',profile,'--wait'],{stdio:'inherit'});
execFileSync('/usr/bin/xcrun',['stapler','staple',artifact],{stdio:'inherit'});
execFileSync('/usr/sbin/spctl',['--assess','--type','open','--context','context:primary-signature','--verbose',artifact],{stdio:'inherit'});
