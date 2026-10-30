import sys, uuid, requests
from requests.auth import HTTPDigestAuth
H, PW = sys.argv[1], sys.argv[2]
URL = f"http://{H}:16992/wsman"
AUTH = HTTPDigestAuth("admin", PW)
NS = {"AMT":"http://intel.com/wbem/wscim/1/amt-schema/1/","IPS":"http://intel.com/wbem/wscim/1/ips-schema/1/","CIM":"http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/"}
def uri(cls): return NS[cls.split("_")[0]] + cls
def env(action, resuri, body="", sel=""):
    return f'''<?xml version="1.0" encoding="utf-8"?><Envelope xmlns="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"><Header><a:Action>{action}</a:Action><a:To>/wsman</a:To><w:ResourceURI>{resuri}</w:ResourceURI><a:MessageID>uuid:{uuid.uuid4()}</a:MessageID><a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo><w:OperationTimeout>PT60S</w:OperationTimeout>{sel}</Header><Body>{body}</Body></Envelope>'''
def post(x):
    r = requests.post(URL, data=x, auth=AUTH, headers={"Content-Type":"application/soap+xml;charset=UTF-8"}, timeout=30)
    return r.status_code, r.text
def get(cls, sel=""):
    return post(env("http://schemas.xmlsoap.org/ws/2004/09/transfer/Get", uri(cls), sel=sel))
def put(cls, inner, sel=""):
    return post(env("http://schemas.xmlsoap.org/ws/2004/09/transfer/Put", uri(cls), f'<h:{cls} xmlns:h="{uri(cls)}">{inner}</h:{cls}>', sel))
def invoke(cls, method, inner, sel=""):
    return post(env(uri(cls)+"/"+method, uri(cls), f'<h:{method}_INPUT xmlns:h="{uri(cls)}">{inner}</h:{method}_INPUT>', sel))
import re
def show(tag, r):
    t = re.sub(r"<[^>]*Header>.*?</[^>]*Header>", "", r[1], flags=re.S)
    print(tag, r[0], re.sub(r"\s+"," ", re.sub(r"<[^>]+>", " ", t))[:600])
mode = sys.argv[3] if len(sys.argv) > 3 else "read"
if mode == "read":
    for c in ["CIM_KVMRedirectionSAP","IPS_KVMRedirectionSettingData","AMT_RedirectionService","IPS_OptInService"]:
        show(c, get(c))
if mode == "enable":
    show("KVM SAP RequestStateChange(2)", invoke("CIM_KVMRedirectionSAP", "RequestStateChange", "<h:RequestedState>2</h:RequestedState>"))
    code, txt = get("AMT_RedirectionService")
    inner = re.search(r"<g:AMT_RedirectionService>(.*?)</g:AMT_RedirectionService>", txt, re.S).group(1)
    inner = inner.replace("g:", "h:").replace("<h:ListenerEnabled>false", "<h:ListenerEnabled>true")
    show("RedirectionService Put", put("AMT_RedirectionService", inner))
    for c in ["CIM_KVMRedirectionSAP","AMT_RedirectionService"]:
        show(c, get(c))
if mode == "static":
    newip = sys.argv[4]
    sel = '<w:SelectorSet><w:Selector Name="InstanceID">Intel(r) AMT Ethernet Port Settings 0</w:Selector></w:SelectorSet>'
    txt = get("AMT_EthernetPortSettings", sel)[1]
    inner = re.search(r"<g:AMT_EthernetPortSettings>(.*?)</g:AMT_EthernetPortSettings>", txt, re.S).group(1)
    inner = re.sub(r"<g:LinkIsUp>.*?</g:LinkIsUp>", "", inner)
    inner = inner.replace("<g:DHCPEnabled>true", "<g:DHCPEnabled>false")
    inner = re.sub(r"<g:IPAddress>.*?</g:IPAddress>", f"<g:IPAddress>{newip}</g:IPAddress>", inner)
    inner = inner.replace("g:", "h:")
    try:
        show("EthernetPortSettings Put", put("AMT_EthernetPortSettings", inner, sel))
    except Exception as e:
        print("Put connection ended (expected if the IP changed):", type(e).__name__)
