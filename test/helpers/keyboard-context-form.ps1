Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition 'public class WakeInputTestForm : System.Windows.Forms.Form { protected override bool ShowWithoutActivation { get { return true; } } }'
$testForm=New-Object WakeInputTestForm
$testForm.Text='MIND Wake - input observer test';$testForm.Width=360;$testForm.Height=120
$testBox=New-Object System.Windows.Forms.TextBox
$testBox.AccessibleName='Test notes';$testBox.Dock='Fill';$testBox.Text='existing before collection'
$testForm.Controls.Add($testBox);$testForm.Show()
$script:testStep=0
$testTimer=New-Object System.Windows.Forms.Timer
$testTimer.Interval=700
$testTimer.add_Tick({
  $script:testStep++
  if($script:testStep -eq 2){$testBox.Text='A useful test note.'}
  if($script:testStep -eq 3){$testBox.UseSystemPasswordChar=$true;$testBox.Text='never-capture-this'}
  if($script:testStep -eq 5){$testBox.UseSystemPasswordChar=$false;$testBox.Text='baseline again'}
  if($script:testStep -eq 6){$testBox.Text='baseline again updated'}
})
$testTimer.Start()
