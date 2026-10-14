import { load } from 'cheerio';
import { CORE,type AuthStatus } from '../shared.js';
import type { SchoolTransport } from './client.js';

export async function checkSchoolSession(transport:SchoolTransport):Promise<{authenticated:boolean;diagnostic:NonNullable<AuthStatus['diagnostic']>}> {
  let url=CORE+'/my/';
  for(let i=0;i<6;i++){
    const response=await transport.fetch(url,{redirect:'manual',signal:AbortSignal.timeout(20_000)});
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');const next=location?new URL(location,url):undefined;
      const diagnostic={stage:next?'redirect_'+next.pathname:'invalid_redirect',httpStatus:response.status};
      if(!next||next.origin!==CORE||/^\/auth\//.test(next.pathname))return{authenticated:false,diagnostic};
      url=next.href;continue;
    }
    if(!response.ok)return{authenticated:false,diagnostic:{stage:'http_response',httpStatus:response.status}};
    const html=await response.text(),$=load(html);
    if(/You are already logged in as|您已经登录为|已登录为/i.test($('body').text()))return{authenticated:true,diagnostic:{stage:'authenticated_login_interstitial',httpStatus:response.status}};
    const login=$('#page-login-index, input[type="password"], form[action*="login"]').length>0;
    const authenticated=!login&&$('a[href*="logout.php"], [data-region="user-menu"], .usermenu, #page-my-index, #page-my-courses, #user-menu-toggle').length>0;
    const title=$('title').text().trim();
    return{authenticated,diagnostic:{stage:authenticated?'authenticated_page':login?'login_page':'unrecognized_page',httpStatus:response.status,...(!authenticated&&!login?{pageTitle:title.slice(0,100)}:{})}};
  }
  return{authenticated:false,diagnostic:{stage:'redirect_limit'}};
}
