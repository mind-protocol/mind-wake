$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'reply-postit.ps1') -Library
$area=New-Object Drawing.Rectangle 0,0,1920,1040
$cases=@(
 @{name='near click';p=(New-Object Drawing.Point 100,100);a=$area;w=460;h=326;x=112;y=112},
 @{name='right edge';p=(New-Object Drawing.Point 1900,100);a=$area;w=460;h=326;x=1428;y=112},
 @{name='bottom edge';p=(New-Object Drawing.Point 100,1030);a=$area;w=460;h=326;x=112;y=692},
 @{name='bottom-right';p=(New-Object Drawing.Point 1900,1030);a=$area;w=460;h=326;x=1428;y=692},
 @{name='negative monitor origin';p=(New-Object Drawing.Point -1900,100);a=(New-Object Drawing.Rectangle -1920,0,1920,1040);w=460;h=326;x=-1888;y=112},
 @{name='negative monitor right edge';p=(New-Object Drawing.Point -10,100);a=(New-Object Drawing.Rectangle -1920,0,1920,1040);w=460;h=326;x=-482;y=112},
 @{name='150 percent physical dimensions';p=(New-Object Drawing.Point 2800,1500);a=(New-Object Drawing.Rectangle 0,0,2880,1560);w=690;h=489;x=2098;y=999}
)
foreach($c in $cases){$p=Resolve-ReplyPostitPosition $c.p $c.a $c.w $c.h;if($p.X -ne $c.x -or $p.Y -ne $c.y){throw ('Position '+$c.name+' got '+$p)};if($p.X -lt $c.a.Left -or $p.Y -lt $c.a.Top -or $p.X+$c.w -gt $c.a.Right -or $p.Y+$c.h -gt $c.a.Bottom){throw ('Outside working area: '+$c.name)}}
'PASS: 7 actual placement function cases, edges, negative monitor coordinates and scaled physical dimensions'
